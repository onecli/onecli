//! One statement as PostgreSQL's own scanner reads it.
//!
//! The parser summary says which statements and which functions a text
//! holds, but not the few details some rules need (a `COPY`'s direction, the
//! name a `PREPARE` binds, the arguments of a `set_config` call, where a
//! cursor's query starts), and it does not list calls in a few places
//! (`EXECUTE` arguments, DDL expressions). Those come from the scanner's
//! tokens, so a comment, a quoted keyword or a string that looks like SQL is
//! never mistaken for code. The tokens also yield the statement's audit text:
//! the code with every literal replaced by a placeholder and every comment
//! dropped.

use pg_query::protobuf::{KeywordKind, Token};

/// PostgreSQL truncates identifiers longer than this (`NAMEDATALEN - 1`).
pub const MAX_IDENTIFIER_BYTES: usize = 63;

/// One code token (comments are dropped at scan time).
#[derive(Debug, Clone, Copy)]
struct Tok {
    kind: Token,
    keyword: KeywordKind,
    start: usize,
    end: usize,
}

/// The code tokens of one statement.
pub struct Tokens<'a> {
    sql: &'a str,
    toks: Vec<Tok>,
}

/// A function-call position: a name directly followed by `(`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    /// Index of the name token.
    pub at: usize,
    /// The function's name as the server resolves it; `None` when it is
    /// spelled in a form the gateway cannot read (a Unicode-escaped name).
    pub name: Option<String>,
    /// The schema it is qualified with (`""` when the qualifier itself is
    /// unreadable), or `None` when unqualified.
    pub schema: Option<String>,
}

impl<'a> Tokens<'a> {
    /// Scan `sql`. Fails only on text the scanner rejects (an unterminated
    /// string or quoted identifier), which the parser rejects too.
    pub fn scan(sql: &'a str) -> Result<Self, pg_query::Error> {
        let scanned = pg_query::scan(sql)?;
        let toks = scanned
            .tokens
            .iter()
            .filter_map(|t| {
                let kind = Token::try_from(t.token).unwrap_or(Token::Nul);
                if matches!(kind, Token::SqlComment | Token::CComment) {
                    return None;
                }
                Some(Tok {
                    kind,
                    keyword: KeywordKind::try_from(t.keyword_kind)
                        .unwrap_or(KeywordKind::NoKeyword),
                    start: usize::try_from(t.start).ok()?,
                    end: usize::try_from(t.end).ok()?,
                })
            })
            .collect();
        Ok(Self { sql, toks })
    }

    pub fn len(&self) -> usize {
        self.toks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.toks.is_empty()
    }

    /// The kind of token `i` (`Nul` out of bounds).
    pub fn kind(&self, i: usize) -> Token {
        self.toks.get(i).map_or(Token::Nul, |t| t.kind)
    }

    pub fn is(&self, i: usize, kind: Token) -> bool {
        self.kind(i) == kind
    }

    /// The source text of token `i`.
    pub fn text(&self, i: usize) -> &'a str {
        self.toks
            .get(i)
            .and_then(|t| self.sql.get(t.start..t.end))
            .unwrap_or("")
    }

    /// The source text from the start of token `from` to the end of token
    /// `to - 1`; empty when the range is empty or out of bounds.
    pub fn span(&self, from: usize, to: usize) -> &'a str {
        if from >= to {
            return "";
        }
        match (self.toks.get(from), self.toks.get(to - 1)) {
            (Some(first), Some(last)) => self.sql.get(first.start..last.end).unwrap_or(""),
            _ => "",
        }
    }

    /// The source text from the start of token `from` to the end.
    pub fn rest(&self, from: usize) -> &'a str {
        self.span(from, self.toks.len())
    }

    /// The index of the `)` closing the `(` at `open`.
    pub fn closing_paren(&self, open: usize) -> Option<usize> {
        if !self.is(open, Token::Ascii40) {
            return None;
        }
        let mut depth = 0usize;
        for (i, tok) in self.toks.iter().enumerate().skip(open) {
            match tok.kind {
                Token::Ascii40 => depth += 1,
                Token::Ascii41 => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The name token `i` spells where SQL expects a plain name (a column,
    /// table, cursor or prepared-statement name): an identifier, or an
    /// unreserved or column-name keyword.
    pub fn name(&self, i: usize) -> Option<String> {
        self.spelled(i, |k| {
            matches!(
                k,
                KeywordKind::UnreservedKeyword | KeywordKind::ColNameKeyword
            )
        })
    }

    /// The name token `i` spells where SQL expects a function name: an
    /// identifier, or an unreserved or type/function-name keyword
    /// (`left`, `right`). Column-name keywords are never function names
    /// (`coalesce(` is syntax, not a call).
    pub fn function_name(&self, i: usize) -> Option<String> {
        self.spelled(i, |k| {
            matches!(
                k,
                KeywordKind::UnreservedKeyword | KeywordKind::TypeFuncNameKeyword
            )
        })
    }

    /// The name at `i` as the server stores it: unquoted folded to lower
    /// case, quoted verbatim, either one truncated to 63 bytes the way the
    /// server's lexer does. `None` for a Unicode-escaped name (`U&"..."`),
    /// which the gateway does not decode, and for keywords `keyword_ok`
    /// rejects.
    fn spelled(&self, i: usize, keyword_ok: fn(KeywordKind) -> bool) -> Option<String> {
        let tok = self.toks.get(i)?;
        let text = self.text(i);
        let name = match tok.kind {
            Token::Ident if text.starts_with('"') => text
                .strip_prefix('"')?
                .strip_suffix('"')?
                .replace("\"\"", "\""),
            Token::Ident => text.to_ascii_lowercase(),
            _ if keyword_ok(tok.keyword) => text.to_ascii_lowercase(),
            _ => return None,
        };
        (!name.is_empty()).then(|| truncate_identifier(name))
    }

    /// The value of a plain string literal at `i` (`'it''s'`). `None` for
    /// any other token, including escape (`E''`), Unicode (`U&''`) and
    /// dollar-quoted strings, and for literals continued across lines
    /// (`'a'` newline `'b'`), which the gateway does not reassemble.
    pub fn string(&self, i: usize) -> Option<String> {
        if !self.is(i, Token::Sconst) {
            return None;
        }
        let inner = self.text(i).strip_prefix('\'')?.strip_suffix('\'')?;
        // Every quote inside a single plain literal is doubled. A lone one
        // means the token is several literals the scanner joined.
        if inner.replace("''", "").contains('\'') {
            return None;
        }
        Some(inner.replace("''", "'"))
    }

    /// The first token at or after `from`, outside any parentheses opened
    /// after `from`, that is one of `kinds`.
    pub fn find_top_level(&self, from: usize, kinds: &[Token]) -> Option<usize> {
        let mut depth = 0usize;
        for (i, tok) in self.toks.iter().enumerate().skip(from) {
            match tok.kind {
                Token::Ascii40 => depth += 1,
                Token::Ascii41 => depth = depth.saturating_sub(1),
                kind if depth == 0 && kinds.contains(&kind) => return Some(i),
                _ => {}
            }
        }
        None
    }

    /// Every function-call position. Over-approximates: a table name before
    /// a column list (`INSERT INTO t (a)`) reads as a call too, which only
    /// ever makes a statement stricter.
    pub fn calls(&self) -> impl Iterator<Item = Call> + '_ {
        (0..self.toks.len()).filter_map(move |i| {
            if !self.is(i + 1, Token::Ascii40) {
                return None;
            }
            let tok = self.toks.get(i)?;
            let callable = matches!(tok.kind, Token::Ident | Token::Uident)
                || matches!(
                    tok.keyword,
                    KeywordKind::UnreservedKeyword | KeywordKind::TypeFuncNameKeyword
                );
            if !callable {
                return None;
            }
            let schema = (i >= 2 && self.is(i - 1, Token::Ascii46))
                .then(|| self.name(i - 2).unwrap_or_default());
            Some(Call {
                at: i,
                name: self.function_name(i),
                schema,
            })
        })
    }

    /// Whether the statement holds a row-locking clause (`FOR UPDATE`,
    /// `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`), which takes locks
    /// other sessions wait on.
    pub fn has_locking_clause(&self) -> bool {
        (0..self.toks.len()).any(|i| {
            self.is(i, Token::For)
                && matches!(
                    self.kind(i + 1),
                    Token::Update | Token::Share | Token::No | Token::Key
                )
        })
    }

    /// The statement as the request log and an approver see it: the code
    /// tokens separated by single spaces where the source had any gap, every
    /// literal replaced by a numbered placeholder (numbered after the
    /// statement's own `$n` parameters), comments gone, at most `max_chars`.
    pub fn audit_text(&self, max_chars: usize) -> String {
        let mut next_placeholder = self
            .toks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == Token::Param)
            .filter_map(|(i, _)| self.text(i).strip_prefix('$')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let mut out = String::new();
        let mut prev_end = None;
        for (i, tok) in self.toks.iter().enumerate() {
            if prev_end.is_some_and(|end| end < tok.start) {
                out.push(' ');
            }
            if is_literal(tok.kind) {
                out.push('$');
                out.push_str(&next_placeholder.to_string());
                next_placeholder = next_placeholder.saturating_add(1);
            } else {
                out.push_str(self.text(i));
            }
            prev_end = Some(tok.end);
            // Bytes bound chars from above: stop once the cut is certain.
            if out.len() > max_chars.saturating_mul(4) {
                break;
            }
        }
        clamp_chars(out, max_chars)
    }
}

/// Literal tokens: the values an audit line must never carry.
fn is_literal(kind: Token) -> bool {
    matches!(
        kind,
        Token::Sconst
            | Token::Usconst
            | Token::Bconst
            | Token::Xconst
            | Token::Iconst
            | Token::Fconst
    )
}

/// An identifier cut to 63 bytes on a character boundary, as the server's
/// lexer does (`truncate_identifier`).
pub fn truncate_identifier(mut name: String) -> String {
    if name.len() > MAX_IDENTIFIER_BYTES {
        let mut cut = MAX_IDENTIFIER_BYTES;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        name.truncate(cut);
    }
    name
}

/// At most `max` characters, ending in `…` when cut.
pub fn clamp_chars(text: String, max: usize) -> String {
    match text.char_indices().nth(max.saturating_sub(1)) {
        Some((cut, _)) if text.chars().count() > max => {
            let mut kept = text[..cut].to_string();
            kept.push('…');
            kept
        }
        _ => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_text_hides_every_literal_and_comment() {
        let sql = "/* key=abc */ SELECT E'p\\'w', $$x$$, U&'d', B'01', X'ff', 1.5, 42, N'n' -- tail\n FROM t WHERE a = $2";
        let tokens = Tokens::scan(sql).unwrap();
        assert_eq!(
            tokens.audit_text(1000),
            "SELECT $3, $4, $5, $6, $7, $8, $9, N$10 FROM t WHERE a = $2"
        );
    }

    #[test]
    fn audit_text_is_clamped() {
        let tokens = Tokens::scan("SELECT aaaaaaaaaa FROM bbbbbbbbbb").unwrap();
        let text = tokens.audit_text(10);
        assert_eq!(text.chars().count(), 10);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn names_fold_and_truncate_like_the_server() {
        let tokens = Tokens::scan(r#"PREPARE Foo "Bar""x" U&"d" update select"#).unwrap();
        assert_eq!(tokens.name(1).as_deref(), Some("foo"));
        assert_eq!(tokens.name(2).as_deref(), Some("Bar\"x"));
        assert_eq!(tokens.name(3), None, "Unicode-escaped");
        assert_eq!(
            tokens.name(4).as_deref(),
            Some("update"),
            "unreserved keyword"
        );
        assert_eq!(tokens.name(5), None, "reserved keyword");
        let long = format!("EXECUTE {}", "a".repeat(70));
        assert_eq!(
            Tokens::scan(&long).unwrap().name(1),
            Some("a".repeat(63)),
            "cut to 63 bytes"
        );
        // A two-byte character straddling byte 63 is dropped whole.
        let wide = format!("EXECUTE \"{}é\"", "a".repeat(62));
        assert_eq!(Tokens::scan(&wide).unwrap().name(1), Some("a".repeat(62)));
    }

    #[test]
    fn function_names_follow_the_function_grammar() {
        let tokens = Tokens::scan("SELECT left('a', 1), coalesce(1)").unwrap();
        assert_eq!(tokens.function_name(1).as_deref(), Some("left"));
        assert_eq!(tokens.function_name(8), None, "coalesce is syntax");
    }

    #[test]
    fn strings_are_read_only_when_plain_and_whole() {
        let tokens = Tokens::scan("SELECT 'it''s', E'x', $$y$$").unwrap();
        assert_eq!(tokens.string(1).as_deref(), Some("it's"));
        assert_eq!(tokens.string(3), None);
        assert_eq!(tokens.string(5), None);
        // The scanner joins literals continued across a newline into one
        // token; its value is not the token's text between the outer quotes.
        let continued = Tokens::scan("SELECT 'ro'\n'le'").unwrap();
        assert_eq!(continued.len(), 2);
        assert_eq!(continued.string(1), None);
    }

    #[test]
    fn top_level_search_skips_parentheses() {
        let tokens = Tokens::scan("COPY (SELECT a FROM t) TO STDOUT").unwrap();
        let to = tokens.find_top_level(1, &[Token::From, Token::To]).unwrap();
        assert_eq!(tokens.text(to), "TO");
        assert_eq!(tokens.rest(to), "TO STDOUT");
        assert_eq!(tokens.closing_paren(1), Some(6));
        assert_eq!(tokens.span(2, 6), "SELECT a FROM t");
        assert_eq!(tokens.closing_paren(2), None, "not a parenthesis");
        let open = Tokens::scan("COPY (SELECT (1").unwrap();
        assert_eq!(open.closing_paren(1), None, "unbalanced");
    }

    #[test]
    fn calls_are_found_outside_strings_and_comments_with_their_schema() {
        let tokens = Tokens::scan(
            "SELECT lower(a), pg_catalog.upper(b), 'f(x)' /* g(y) */, U&\"h\"(1) FROM t FOR KEY SHARE",
        )
        .unwrap();
        let calls: Vec<_> = tokens.calls().collect();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].name.as_deref(), Some("lower"));
        assert_eq!(calls[0].schema, None);
        assert_eq!(calls[1].name.as_deref(), Some("upper"));
        assert_eq!(calls[1].schema.as_deref(), Some("pg_catalog"));
        assert_eq!(calls[2].name, None, "Unicode-escaped");
        assert!(tokens.has_locking_clause());
        assert!(!Tokens::scan("SELECT 'FOR UPDATE'")
            .unwrap()
            .has_locking_clause());
    }
}
