//! Reading a GraphQL request the way an approver needs it: which operation
//! runs, every top-level field it calls, and the arguments each one is given,
//! with `$variables` filled in from the request's own `variables`.
//! `change_simple_column_value(board_id: 5, column_id: "status", value:
//! "Done")` reads as `{board_id: 5, column_id: "status", value: "Done"}`, so
//! the card says "Value: Done", not the raw document.
//!
//! A small, bounded reader of the parts of the grammar that decide this:
//! operations (shorthand, named, several in one document picked by
//! `operationName` as the spec requires), fragment definitions (skipped),
//! directives, and the value grammar: strings with escapes, block strings,
//! numbers, booleans, null, enums, variables, lists and input objects. A
//! fragment spread at the top of an operation hides which fields run, so it
//! makes the document unreadable, as does anything past the reader's bounds;
//! the card then shows the document as written, with every secret-named
//! argument masked ([`mask_secrets`]). A variable named like a secret
//! (`$password`) reads as `***` wherever it is passed. Pure; no I/O.

use serde_json::{Map, Value};

use super::redact::is_sensitive_key;

/// Most bytes of a document read, how deep values nest, and how many
/// top-level fields one operation may call.
const MAX_DOC: usize = 16 * 1024;
const MAX_DEPTH: usize = 8;
const MAX_FIELDS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Query,
    Mutation,
    Subscription,
}

/// One top-level field the operation calls, by its real name (an alias is
/// only the answer's key).
#[derive(Debug, PartialEq)]
pub(crate) struct Field {
    pub(crate) name: String,
    pub(crate) args: Map<String, Value>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Operation {
    pub(crate) kind: Kind,
    pub(crate) fields: Vec<Field>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Read {
    /// Not a GraphQL document: some other body with a `query` string.
    NotGraphql,
    /// A GraphQL document this reader can't place.
    Unreadable,
    Operation(Operation),
}

/// The operation `doc` runs: the one `operation_name` names, or the only one
/// the document has. Every operation has a selection set, so text with no
/// `{` (a search phrase that happens to start with "query") is not GraphQL.
pub(crate) fn read(doc: &str, vars: Option<&Value>, operation_name: Option<&str>) -> Read {
    let mut p = Parser::new(doc, vars);
    p.ws();
    if !p.at_definition() || !doc.contains('{') {
        return Read::NotGraphql;
    }
    if doc.len() > MAX_DOC {
        return Read::Unreadable;
    }
    p.document(operation_name)
        .map_or(Read::Unreadable, Read::Operation)
}

/// `doc` as written, with the value of every secret-named argument or
/// input field (`password: "x"`, `{apiKey: "y"}`) replaced by `"***"`. A
/// value that can't be read through is masked to the end of the document.
pub(crate) fn mask_secrets(doc: &str) -> String {
    let mut p = Parser::new(doc, None);
    let mut out = String::with_capacity(doc.len());
    let mut copied = 0;
    while let Some(c) = p.peek() {
        match c {
            b'"' => {
                if p.string().is_none() {
                    break;
                }
            }
            b'#' => p.comment(),
            // A variable's own name (`$token: String`) is not a key.
            b'$' => {
                p.i += 1;
                let _ = p.name();
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let name = p.name().unwrap_or_default();
                let after = p.i;
                p.ws();
                if p.peek() != Some(b':') || !is_sensitive_key(&name) {
                    p.i = after;
                    continue;
                }
                p.i += 1;
                p.ws();
                out.push_str(&doc[copied..p.i]);
                out.push_str("\"***\"");
                if p.value(0).is_none() {
                    return out;
                }
                copied = p.i;
            }
            _ => p.i += 1,
        }
    }
    out.push_str(&doc[copied..]);
    out
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    vars: Option<&'a Value>,
}

impl<'a> Parser<'a> {
    fn new(doc: &'a str, vars: Option<&'a Value>) -> Self {
        Self {
            s: doc.as_bytes(),
            i: 0,
            vars,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn rest(&self) -> &[u8] {
        self.s.get(self.i..).unwrap_or_default()
    }

    /// Ignored tokens: whitespace, line terminators, commas, `#` comments
    /// and a byte order mark.
    fn ws(&mut self) {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r' | b',') => self.i += 1,
                Some(b'#') => self.comment(),
                Some(0xEF) if self.rest().starts_with(&[0xEF, 0xBB, 0xBF]) => self.i += 3,
                _ => return,
            }
        }
    }

    fn comment(&mut self) {
        while self.peek().is_some_and(|c| c != b'\n' && c != b'\r') {
            self.i += 1;
        }
    }

    fn expect(&mut self, c: u8) -> Option<()> {
        self.ws();
        (self.peek() == Some(c)).then(|| self.i += 1)
    }

    fn name(&mut self) -> Option<String> {
        let start = self.i;
        if !self
            .peek()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        {
            return None;
        }
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            self.i += 1;
        }
        std::str::from_utf8(&self.s[start..self.i])
            .ok()
            .map(str::to_string)
    }

    /// Whether a definition starts here: a shorthand `{` or an operation or
    /// fragment keyword.
    fn at_definition(&self) -> bool {
        if self.peek() == Some(b'{') {
            return true;
        }
        let rest = self.rest();
        ["query", "mutation", "subscription", "fragment"]
            .iter()
            .any(|k| {
                rest.starts_with(k.as_bytes())
                    && !rest
                        .get(k.len())
                        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
            })
    }

    /// Every definition of the document, keeping the operation it runs.
    fn document(&mut self, wanted: Option<&str>) -> Option<Operation> {
        let mut chosen = None;
        let mut operations = 0usize;
        loop {
            self.ws();
            if self.peek().is_none() {
                break;
            }
            let (kind, name) = if self.peek() == Some(b'{') {
                (Kind::Query, None)
            } else {
                match self.name()?.as_str() {
                    "fragment" => {
                        self.fragment()?;
                        continue;
                    }
                    "query" => (Kind::Query, self.operation_header()?),
                    "mutation" => (Kind::Mutation, self.operation_header()?),
                    "subscription" => (Kind::Subscription, self.operation_header()?),
                    _ => return None,
                }
            };
            operations += 1;
            self.ws();
            if self.peek() != Some(b'{') {
                return None;
            }
            let runs = wanted.is_none_or(|w| name.as_deref() == Some(w));
            if !runs {
                self.skip_balanced(b'{', b'}')?;
                continue;
            }
            // Two operations it could run: the request must name one.
            if chosen.is_some() {
                return None;
            }
            let fields = self.top_fields()?;
            chosen = Some(Operation { kind, fields });
        }
        // Several operations and no name: the server refuses it, and the
        // card can't say which one would run.
        if wanted.is_none() && operations != 1 {
            return None;
        }
        chosen
    }

    /// `[Name] [($vars)] [@directives]` after an operation keyword; the
    /// operation's name.
    fn operation_header(&mut self) -> Option<Option<String>> {
        self.ws();
        let name = if self
            .peek()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        {
            self.name()
        } else {
            None
        };
        self.ws();
        if self.peek() == Some(b'(') {
            self.skip_balanced(b'(', b')')?;
        }
        self.directives()?;
        Some(name)
    }

    /// `fragment Name on Type [@directives] { … }`: skipped whole.
    fn fragment(&mut self) -> Option<()> {
        self.ws();
        self.name()?;
        self.ws();
        (self.name()? == "on").then_some(())?;
        self.ws();
        self.name()?;
        self.directives()?;
        self.ws();
        self.skip_balanced(b'{', b'}')
    }

    /// The fields an operation's selection set calls at its top level.
    fn top_fields(&mut self) -> Option<Vec<Field>> {
        self.expect(b'{')?;
        let mut fields = Vec::new();
        loop {
            self.ws();
            match self.peek()? {
                b'}' => {
                    self.i += 1;
                    break;
                }
                // `...Fragment` or an inline fragment: which fields run is
                // not written here.
                b'.' => return None,
                _ => {}
            }
            if fields.len() == MAX_FIELDS {
                return None;
            }
            let first = self.name()?;
            self.ws();
            // `alias: field` names the real field second.
            let name = if self.peek() == Some(b':') {
                self.i += 1;
                self.ws();
                self.name()?
            } else {
                first
            };
            self.ws();
            let args = if self.peek() == Some(b'(') {
                self.arguments()?
            } else {
                Map::new()
            };
            self.directives()?;
            self.ws();
            if self.peek() == Some(b'{') {
                self.skip_balanced(b'{', b'}')?;
            }
            fields.push(Field { name, args });
        }
        (!fields.is_empty()).then_some(fields)
    }

    fn arguments(&mut self) -> Option<Map<String, Value>> {
        self.expect(b'(')?;
        let mut args = Map::new();
        loop {
            self.ws();
            if self.peek()? == b')' {
                self.i += 1;
                return Some(args);
            }
            let key = self.name()?;
            self.expect(b':')?;
            let value = self.value(0)?;
            args.insert(key, value);
        }
    }

    fn directives(&mut self) -> Option<()> {
        loop {
            self.ws();
            if self.peek() != Some(b'@') {
                return Some(());
            }
            self.i += 1;
            self.name()?;
            self.ws();
            if self.peek() == Some(b'(') {
                self.arguments()?;
            }
        }
    }

    /// Past the bracketed group opening here (`{…}` or `(…)`), reading
    /// strings and comments as such, so a brace inside one doesn't count.
    fn skip_balanced(&mut self, open: u8, close: u8) -> Option<()> {
        let mut depth = 0usize;
        loop {
            match self.peek()? {
                b'"' => {
                    self.string()?;
                    continue;
                }
                b'#' => {
                    self.comment();
                    continue;
                }
                c if c == open => depth += 1,
                c if c == close => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        self.i += 1;
                        return Some(());
                    }
                }
                _ => {}
            }
            self.i += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.ws();
        match self.peek()? {
            b'"' => self.string().map(Value::String),
            b'$' => {
                self.i += 1;
                let name = self.name()?;
                if is_sensitive_key(&name) {
                    return Some(Value::String("***".into()));
                }
                Some(
                    self.vars
                        .and_then(|v| v.get(&name))
                        .cloned()
                        .unwrap_or_else(|| Value::String(format!("${name}"))),
                )
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                loop {
                    self.ws();
                    if self.peek()? == b']' {
                        self.i += 1;
                        return Some(Value::Array(items));
                    }
                    items.push(self.value(depth + 1)?);
                }
            }
            b'{' => {
                self.i += 1;
                let mut obj = Map::new();
                loop {
                    self.ws();
                    if self.peek()? == b'}' {
                        self.i += 1;
                        return Some(Value::Object(obj));
                    }
                    let key = self.name()?;
                    self.expect(b':')?;
                    let v = self.value(depth + 1)?;
                    obj.insert(key, v);
                }
            }
            c if c == b'-' || c.is_ascii_digit() => self.number(),
            _ => {
                let word = self.name()?;
                Some(match word.as_str() {
                    "true" => Value::Bool(true),
                    "false" => Value::Bool(false),
                    "null" => Value::Null,
                    // An enum value reads as its name.
                    _ => Value::String(word),
                })
            }
        }
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.' | b'e' | b'E'))
        {
            self.i += 1;
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).ok()?;
        serde_json::from_str::<serde_json::Number>(text)
            .ok()
            .map(Value::Number)
    }

    /// A `"…"` string (JSON's escapes) or a `"""…"""` block string.
    fn string(&mut self) -> Option<String> {
        if self.rest().starts_with(b"\"\"\"") {
            return self.block_string();
        }
        let start = self.i;
        self.i += 1;
        while let Some(c) = self.peek() {
            match c {
                b'\\' => self.i += 2,
                b'"' => {
                    self.i += 1;
                    return serde_json::from_slice(&self.s[start..self.i]).ok();
                }
                _ => self.i += 1,
            }
        }
        None
    }

    /// A block string's value: `\"""` is a literal `"""`, and the text
    /// reads as the spec's `BlockStringValue` (common indentation and blank
    /// first and last lines removed).
    fn block_string(&mut self) -> Option<String> {
        self.i += 3;
        let mut raw = Vec::new();
        loop {
            let rest = self.rest();
            if rest.is_empty() {
                return None;
            }
            if rest.starts_with(b"\\\"\"\"") {
                raw.extend_from_slice(b"\"\"\"");
                self.i += 4;
            } else if rest.starts_with(b"\"\"\"") {
                self.i += 3;
                break;
            } else {
                raw.push(rest[0]);
                self.i += 1;
            }
        }
        String::from_utf8(raw).ok().map(|r| block_string_value(&r))
    }
}

/// The GraphQL spec's `BlockStringValue(rawValue)`.
fn block_string_value(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .split("\r\n")
        .flat_map(|l| l.split(['\n', '\r']))
        .collect();
    let indent = |l: &str| l.len() - l.trim_start_matches([' ', '\t']).len();
    let common = lines
        .iter()
        .skip(1)
        .filter(|l| indent(l) < l.len())
        .map(|l| indent(l))
        .min();
    let mut out: Vec<&str> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| match common {
            Some(c) if i > 0 => &l[c.min(l.len())..],
            _ => l,
        })
        .collect();
    let blank = |l: &&str| l.trim_matches([' ', '\t']).is_empty();
    while out.first().is_some_and(blank) {
        out.remove(0);
    }
    while out.last().is_some_and(blank) {
        out.pop();
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn op(doc: &str, vars: Option<&Value>, name: Option<&str>) -> Operation {
        match read(doc, vars, name) {
            Read::Operation(op) => op,
            other => panic!("{doc}: {other:?}"),
        }
    }

    fn args(doc: &str, vars: Option<&Value>) -> Value {
        let mut op = op(doc, vars, None);
        assert_eq!(op.fields.len(), 1, "{doc}");
        Value::Object(op.fields.remove(0).args)
    }

    #[test]
    fn literal_arguments_read_as_values() {
        let q = r#"mutation { change_simple_column_value(board_id: 1234567890, item_id: 9876543210, column_id: "status", value: "Done") { id } }"#;
        assert_eq!(
            args(q, None),
            json!({"board_id": 1234567890u64, "item_id": 9876543210u64, "column_id": "status", "value": "Done"})
        );
        assert_eq!(op(q, None, None).kind, Kind::Mutation);
    }

    #[test]
    fn variables_input_objects_lists_enums_and_aliases() {
        let q = r#"mutation Update($id: ID!, $t: String = "{") { renamed: productUpdate(input: {id: $id, title: $t, tags: ["a", "b"], status: ACTIVE}) @include(if: true) { product { id } } }"#;
        let vars = json!({"id": "gid://shopify/Product/1", "t": "New"});
        let op = op(q, Some(&vars), None);
        assert_eq!(op.fields[0].name, "productUpdate");
        assert_eq!(
            Value::Object(op.fields[0].args.clone()),
            json!({"input": {"id": "gid://shopify/Product/1", "title": "New", "tags": ["a", "b"], "status": "ACTIVE"}})
        );
    }

    #[test]
    fn every_top_level_field_is_read() {
        // monday's documented batch: several aliased mutations in one call.
        let q = r#"mutation {
            a: change_simple_column_value(board_id: 1, item_id: 11, column_id: "text", value: "x") { id }
            b: delete_item(item_id: 12) { id }
        }"#;
        let op = op(q, None, None);
        let names: Vec<&str> = op.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["change_simple_column_value", "delete_item"]);
        assert_eq!(op.fields[1].args["item_id"], json!(12));
    }

    #[test]
    fn operation_name_picks_the_operation_that_runs() {
        let q =
            "query Look { me { id } } mutation Wipe { deleteAll { ok } } fragment F on X { id }";
        let wipe = op(q, None, Some("Wipe"));
        assert_eq!(
            (wipe.kind, wipe.fields[0].name.as_str()),
            (Kind::Mutation, "deleteAll")
        );
        // Two operations and no name: the server refuses it; so does the card.
        assert_eq!(read(q, None, None), Read::Unreadable);
        assert_eq!(read(q, None, Some("Missing")), Read::Unreadable);
    }

    #[test]
    fn a_secret_variable_reads_masked_wherever_it_is_passed() {
        let q = "mutation($password: String!) { connect(credential: $password, user: $u) { ok } }";
        let vars = json!({"password": "hunter2", "u": "ada"});
        assert_eq!(
            args(q, Some(&vars)),
            json!({"credential": "***", "user": "ada"})
        );
    }

    #[test]
    fn strings_keep_their_escapes_and_block_strings_read_as_the_spec_says() {
        let q = "mutation { a(x: \"say \\\"hi\\\" {not a brace}\", y: \"\"\"\n    line one\n      line two\n    \\\"\"\" quoted\n\"\"\") { id } }";
        let a = args(q, None);
        assert_eq!(a["x"], json!("say \"hi\" {not a brace}"));
        assert_eq!(a["y"], json!("line one\n  line two\n\"\"\" quoted"));
    }

    #[test]
    fn comments_and_shorthand_documents_read() {
        let op = op("# note\n{ me { id } }", None, None);
        assert_eq!((op.kind, op.fields[0].name.as_str()), (Kind::Query, "me"));
        assert!(op.fields[0].args.is_empty());
    }

    #[test]
    fn what_it_cannot_read_says_so() {
        for q in [
            "mutation { ...Everything }",
            "mutation { a(x: ) { id } }",
            "mutation { a(x: \"open",
            "mutation { a(x: 1",
            "mutation { a(x: [1, 2",
            "mutation { a(x: {k: 1",
            "mutation { }",
            &format!("mutation {{ a(x: {}1{}) }}", "[".repeat(20), "]".repeat(20)),
        ] {
            assert_eq!(read(q, None, None), Read::Unreadable, "{q}");
        }
        for q in [
            "shoes",
            "SELECT Id FROM Account",
            "querystring",
            "query about shoes",
        ] {
            assert_eq!(read(q, None, None), Read::NotGraphql, "{q}");
        }
    }

    #[test]
    fn secrets_in_a_document_as_written_are_masked() {
        let q = r#"mutation($token: String) { login(email: "a@b", password: "hunter2", opts: {apiKey: "k1", n: 1}) { token } }"#;
        let masked = mask_secrets(q);
        assert!(
            !masked.contains("hunter2") && !masked.contains("k1"),
            "{masked}"
        );
        assert!(masked.contains(r#"password: "***""#), "{masked}");
        assert!(masked.contains(r#"email: "a@b""#), "{masked}");
        assert!(masked.contains("$token: String"), "{masked}");
        // Cut off inside a secret: masked through the end.
        let masked = mask_secrets(r#"mutation { a(secret: "abcdef"#);
        assert!(!masked.contains("abcdef"), "{masked}");
    }
}
