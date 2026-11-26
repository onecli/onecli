//! A JSON body the gateway may have cut short, read one value at a time.
//!
//! Every value that ends before the cut is parsed by `serde_json`, so
//! escapes, key order and nesting read exactly as the upstream will read
//! them, and a read stops at the cut ([`Stop::Cut`]) instead of guessing past
//! it. A card built on it can say how far it got: the Salesforce file cards
//! list each upload a batch holds before the cut, and the fields the cut
//! record still holds.

use serde::de::{Deserialize, Deserializer, Visitor};

/// Why a read stopped before the value's end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stop {
    /// The body ends first: the gateway read only a prefix of it.
    Cut,
    /// The bytes are not JSON of the expected shape.
    Bad,
}

/// A read of a (possibly cut) body: the value, or why it stopped.
pub(crate) type Read<T> = Result<T, Stop>;

/// The items of the object or array a [`Cursor`] entered.
pub(crate) struct Items {
    close: u8,
    first: bool,
}

/// A position in a (possibly cut) JSON body.
pub(crate) struct Cursor<'a> {
    body: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(body: &'a [u8]) -> Self {
        Self { body, pos: 0 }
    }

    /// Enter the object (`b'{'`) or array (`b'['`) at the cursor.
    pub(crate) fn enter(&mut self, open: u8) -> Read<Items> {
        let close = match open {
            b'{' => b'}',
            b'[' => b']',
            _ => return Err(Stop::Bad),
        };
        if self.byte()? != open {
            return Err(Stop::Bad);
        }
        self.pos += 1;
        Ok(Items { close, first: true })
    }

    /// Step to the next item of `items`, past the comma before it: `false`
    /// once past its closing bracket.
    pub(crate) fn next(&mut self, items: &mut Items) -> Read<bool> {
        let b = self.byte()?;
        if b == items.close {
            self.pos += 1;
            return Ok(false);
        }
        if !items.first {
            if b != b',' {
                return Err(Stop::Bad);
            }
            self.pos += 1;
        }
        items.first = false;
        Ok(true)
    }

    /// The key of the object item at the cursor, past its colon.
    pub(crate) fn key(&mut self) -> Read<String> {
        let key = self.value()?;
        if self.byte()? != b':' {
            return Err(Stop::Bad);
        }
        self.pos += 1;
        Ok(key)
    }

    /// The body ends here, past whitespace: anything more is `Bad`.
    pub(crate) fn finish(&mut self) -> Read<()> {
        match self.byte() {
            Ok(_) => Err(Stop::Bad),
            Err(_) => Ok(()),
        }
    }

    /// The whole value at the cursor, as `T` (`serde::de::IgnoredAny` steps
    /// over it, [`TextLen`] measures a string without copying it). A number
    /// that runs to the body's end may go on past the cut, so it is `Cut`.
    pub(crate) fn value<T: Deserialize<'a>>(&mut self) -> Read<T> {
        let rest = self.body.get(self.pos..).unwrap_or_default();
        let mut values = serde_json::Deserializer::from_slice(rest).into_iter::<T>();
        match values.next() {
            Some(Ok(v)) => {
                let end = values.byte_offset();
                if end == rest.len() && rest.last().is_some_and(u8::is_ascii_digit) {
                    return Err(Stop::Cut);
                }
                self.pos += end;
                Ok(v)
            }
            Some(Err(e)) if !e.is_eof() => Err(Stop::Bad),
            Some(Err(_)) | None => Err(Stop::Cut),
        }
    }

    /// How much of the string at the cursor the body holds when the cut
    /// falls inside it: its bytes so far, an escape counted as the one
    /// character it stands for, so a lower bound on the string's length.
    /// `None` when the cursor is not on an unclosed string.
    pub(crate) fn open_string_len(&self) -> Option<usize> {
        let rest = self.body.get(self.pos..)?;
        let start = rest.iter().position(|b| !is_json_space(*b))?;
        let mut text = rest[start..].strip_prefix(b"\"")?;
        let mut len = 0;
        while let Some((&b, tail)) = text.split_first() {
            text = match b {
                b'"' => return None,
                b'\\' if tail.first() == Some(&b'u') => tail.get(5..).unwrap_or_default(),
                b'\\' => tail.get(1..).unwrap_or_default(),
                _ => tail,
            };
            len += 1;
        }
        Some(len)
    }

    /// The next byte past whitespace, not consumed. `Cut` at the body's end.
    fn byte(&mut self) -> Read<u8> {
        while let Some(&b) = self.body.get(self.pos) {
            if !is_json_space(b) {
                return Ok(b);
            }
            self.pos += 1;
        }
        Err(Stop::Cut)
    }
}

/// JSON's own whitespace (narrower than ASCII's: no form feed).
fn is_json_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// The length in bytes of a JSON string value, read without copying it (a
/// file's base64 runs to megabytes).
pub(crate) struct TextLen(pub(crate) usize);

impl<'de> Deserialize<'de> for TextLen {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Len;
        impl Visitor<'_> for Len {
            type Value = TextLen;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string")
            }
            fn visit_str<E>(self, s: &str) -> Result<TextLen, E> {
                Ok(TextLen(s.len()))
            }
        }
        d.deserialize_str(Len)
    }
}

#[cfg(test)]
mod tests {
    use serde::de::IgnoredAny;
    use serde_json::Value;

    use super::*;

    /// Every `(key, value)` of the object at the start of `body` before the
    /// read stopped, and how it stopped.
    fn members(body: &str) -> (Vec<(String, Value)>, Read<()>) {
        let mut cur = Cursor::new(body.as_bytes());
        let mut out = Vec::new();
        let mut read = || -> Read<()> {
            let mut items = cur.enter(b'{')?;
            while cur.next(&mut items)? {
                let key = cur.key()?;
                out.push((key, cur.value()?));
            }
            Ok(())
        };
        let stop = read();
        (out, stop)
    }

    #[test]
    fn a_whole_object_reads_exactly_whatever_its_key_order_and_escapes() {
        let (fields, stop) = members(r#" { "b" : "say \"hi\"" , "a":[1,{"x":null}], "c":true } "#);
        assert_eq!(stop, Ok(()));
        assert_eq!(
            fields,
            vec![
                ("b".into(), Value::from("say \"hi\"")),
                ("a".into(), serde_json::json!([1, {"x": null}])),
                ("c".into(), Value::from(true)),
            ]
        );
    }

    #[test]
    fn a_cut_keeps_every_value_before_it_and_says_it_was_cut() {
        for cut in [
            r#"{"a":1,"b":"x"#,
            r#"{"a":1,"b"#,
            r#"{"a":1,"b":"#,
            r#"{"a":1,"b":[1,2"#,
            r#"{"a":1,"#,
            r#"{"a":1 "#,
        ] {
            let (fields, stop) = members(cut);
            assert_eq!(stop, Err(Stop::Cut), "{cut}");
            assert_eq!(fields, vec![("a".into(), Value::from(1))], "{cut}");
        }
    }

    #[test]
    fn a_number_cut_at_the_end_is_never_read_as_whole() {
        // `1` may be the start of `12`: only what closes before the cut counts.
        let (fields, stop) = members(r#"{"a":"x","b":1"#);
        assert_eq!(stop, Err(Stop::Cut));
        assert_eq!(fields, vec![("a".into(), Value::from("x"))]);
        // A string closes itself, so one at the very end is whole.
        let (fields, _) = members(r#"{"a":"x""#);
        assert_eq!(fields, vec![("a".into(), Value::from("x"))]);
    }

    #[test]
    fn json_it_cannot_be_is_bad_never_cut() {
        for bad in [
            r#"{"a":1 "b":2}"#,
            r#"{"a":1,}"#,
            r#"{,"a":1}"#,
            r#"{"a" 1}"#,
            r#"{1:2}"#,
            r#"["a"]"#,
            r#"{"a":tru,"#,
        ] {
            assert_eq!(members(bad).1, Err(Stop::Bad), "{bad}");
        }
    }

    #[test]
    fn a_string_is_measured_without_reading_it_and_bounded_when_cut() {
        let mut cur = Cursor::new(br#""QUJD\/QUJD", "QUJD\/\u0041QU"#);
        assert_eq!(cur.value::<TextLen>().map(|l| l.0), Ok(9));
        let mut items = Items {
            close: b']',
            first: false,
        };
        assert_eq!(cur.next(&mut items), Ok(true));
        assert!(matches!(cur.value::<TextLen>(), Err(Stop::Cut)));
        // Q U J D / A Q U: each escape counts as one character.
        assert_eq!(cur.open_string_len(), Some(8));
        assert_eq!(cur.value::<IgnoredAny>().err(), Some(Stop::Cut));
    }

    #[test]
    fn only_an_unclosed_string_has_an_open_length() {
        assert_eq!(Cursor::new(br#"  "abc"#).open_string_len(), Some(3));
        assert_eq!(Cursor::new(br#""abc""#).open_string_len(), None);
        assert_eq!(Cursor::new(b"123").open_string_len(), None);
    }

    #[test]
    fn a_body_finishes_only_on_whitespace() {
        let mut whole = Cursor::new(b"{} \r\n");
        assert_eq!(whole.value::<IgnoredAny>().err(), None);
        assert_eq!(whole.finish(), Ok(()));
        let mut trailing = Cursor::new(b"{} {}");
        assert_eq!(trailing.value::<IgnoredAny>().err(), None);
        assert_eq!(trailing.finish(), Err(Stop::Bad));
    }
}
