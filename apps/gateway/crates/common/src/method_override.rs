//! The spellings through which a client can ask an upstream to run a request
//! as a different HTTP method than its request line. One list, shared by the
//! proxy's override refusal (`proxy::method_override`) and the Drive folder
//! guard, so the two can't drift.

/// Override headers, lowercase (`HeaderMap` lookups are case-insensitive):
/// `X-HTTP-Method-Override` (Google's documented system parameter and the
/// common convention), `X-HTTP-Method` (SharePoint and other OData services),
/// `X-Method-Override`, and `X-Goog-Http-Method-Override`.
pub const HEADERS: &[&str] = &[
    "x-http-method-override",
    "x-http-method",
    "x-method-override",
    "x-goog-http-method-override",
];

/// Override query parameters, lowercase; compare a decoded name
/// case-insensitively. `_HttpMethod` is Salesforce's (documented as
/// case-sensitive there, so folding case only ever adds refusals) and
/// `_method` the Rails/Laravel convention. `$httpMethod` is not among
/// Google's documented system parameters, but Google reads every `$` name as
/// one, so it is listed defensively.
pub const PARAMS: &[&str] = &["_httpmethod", "_method", "$httpmethod"];
