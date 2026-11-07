//! Per-request disambiguation of custom (generic) secrets.
//!
//! Two custom secrets can target the same injection *slot* (the same header,
//! query parameter, or the URL path) on the same host. [`apply_injections`]
//! would apply both with last-writer-wins, so which credential went upstream
//! depended on unordered pool rows. This module decides one winner per slot,
//! or reports the collision so the agent can pin one with
//! `x-onecli-connection-id`, exactly like several accounts of one app.
//!
//! Resolution per slot, among the tagged rules whose path matches:
//! 1. a pin naming a member of the slot keeps only that member;
//! 2. workspace secrets shadow organization secrets (historical behavior);
//! 3. the most specific `path_pattern` wins;
//! 4. two or more left over is ambiguous.
//!
//! Untagged rules (LLM keys, the platform credit, apps, vault) pass through
//! untouched: only generic secrets are ever candidates.
//!
//! [`apply_injections`]: crate::apply_injections

use serde::{Deserialize, Serialize};

use crate::{is_catch_all_pattern, path_matches, Injection, InjectionRule};

/// Identity of the custom secret an [`InjectionRule`] came from. Never
/// carries a value: it is safe to show to the agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretRef {
    pub id: String,
    pub name: String,
    /// "workspace" | "organization".
    pub scope: String,
}

/// Outcome of [`disambiguate_secret_rules`].
#[derive(Debug, PartialEq)]
pub enum SecretDisambiguation {
    /// One rule per slot at most; losers were dropped.
    Resolved(Vec<InjectionRule>),
    /// Two or more secrets remain for one slot and no pin chose between them.
    Ambiguous(Vec<SecretRef>),
}

/// The slot an injection writes to. Header names compare case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Slot {
    Header(String),
    Param(String),
    Path,
}

fn slots_of(rule: &InjectionRule) -> Vec<Slot> {
    rule.injections
        .iter()
        .filter_map(|inj| match inj {
            Injection::SetHeader { name, .. } | Injection::ReplaceHeader { name, .. } => {
                Some(Slot::Header(name.to_ascii_lowercase()))
            }
            Injection::SetParam { name, .. } => Some(Slot::Param(name.clone())),
            Injection::SetPath { .. } | Injection::ReplacePathRegex { .. } => Some(Slot::Path),
            Injection::RemoveHeader { .. } => None,
        })
        .collect()
}

/// Higher is more specific. Exact patterns beat wildcard ones, longer
/// literal text beats shorter, catch-alls rank last.
fn specificity(pattern: &str) -> (u8, usize) {
    if is_catch_all_pattern(pattern) {
        return (0, 0);
    }
    let literal = pattern.chars().filter(|c| *c != '*').count();
    let exact = u8::from(!pattern.contains('*'));
    (1 + exact, literal)
}

/// True when `id` names a custom secret among `rules`.
#[must_use]
pub fn rules_name_secret(rules: &[InjectionRule], id: &str) -> bool {
    rules
        .iter()
        .any(|r| r.secret.as_ref().is_some_and(|s| s.id == id))
}

/// Every custom secret on this host that shares a slot with another one,
/// regardless of path. Advertised in `x-onecli-connections` so the agent
/// learns the ids before it hits a collision.
#[must_use]
pub fn colliding_secrets(rules: &[InjectionRule]) -> Vec<SecretRef> {
    let mut out: Vec<SecretRef> = Vec::new();
    let tagged: Vec<(&SecretRef, Vec<Slot>)> = rules
        .iter()
        .filter_map(|r| r.secret.as_ref().map(|s| (s, slots_of(r))))
        .collect();
    for (i, (secret, slots)) in tagged.iter().enumerate() {
        let collides = tagged.iter().enumerate().any(|(j, (other, other_slots))| {
            i != j && other.id != secret.id && slots.iter().any(|s| other_slots.contains(s))
        });
        if collides && !out.iter().any(|o| o.id == secret.id) {
            out.push((*secret).clone());
        }
    }
    out
}

/// Pick at most one custom secret per slot for this request. See the module
/// docs for the order. `pin` is the `x-onecli-connection-id` value; it only
/// ever selects among `rules` (already fenced to the agent's pool).
#[must_use]
pub fn disambiguate_secret_rules(
    rules: Vec<InjectionRule>,
    request_path: Option<&str>,
    pin: Option<&str>,
) -> SecretDisambiguation {
    let Some(path) = request_path else {
        return SecretDisambiguation::Resolved(rules);
    };

    // Candidates: tagged rules that serve this path, with their secret.
    let candidates: Vec<(usize, &SecretRef)> = rules
        .iter()
        .enumerate()
        .filter(|(_, r)| path_matches(path, &r.path_pattern))
        .filter_map(|(i, r)| r.secret.as_ref().map(|s| (i, s)))
        .collect();

    let mut slots: Vec<(Slot, Vec<(usize, &SecretRef)>)> = Vec::new();
    for &(i, secret) in &candidates {
        for slot in slots_of(&rules[i]) {
            match slots.iter_mut().find(|(s, _)| *s == slot) {
                Some((_, members)) => {
                    if !members.iter().any(|&(j, _)| j == i) {
                        members.push((i, secret));
                    }
                }
                None => slots.push((slot, vec![(i, secret)])),
            }
        }
    }

    let mut dropped: Vec<usize> = Vec::new();
    for (_, members) in &slots {
        if members.len() < 2 {
            continue;
        }
        let pinned: Vec<(usize, &SecretRef)> = members
            .iter()
            .copied()
            .filter(|(_, s)| pin.is_some_and(|p| s.id == p))
            .collect();
        let winners = if pinned.is_empty() {
            let has_workspace = members.iter().any(|(_, s)| s.scope != "organization");
            let scoped: Vec<(usize, &SecretRef)> = members
                .iter()
                .copied()
                .filter(|(_, s)| !has_workspace || s.scope != "organization")
                .collect();
            let best = scoped
                .iter()
                .map(|&(i, _)| specificity(&rules[i].path_pattern))
                .max();
            scoped
                .into_iter()
                .filter(|&(i, _)| Some(specificity(&rules[i].path_pattern)) == best)
                .collect()
        } else {
            pinned
        };
        if winners.len() >= 2 {
            return SecretDisambiguation::Ambiguous(
                winners.into_iter().map(|(_, s)| s.clone()).collect(),
            );
        }
        dropped.extend(
            members
                .iter()
                .map(|&(i, _)| i)
                .filter(|i| !winners.iter().any(|&(w, _)| w == *i)),
        );
    }

    SecretDisambiguation::Resolved(
        rules
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !dropped.contains(i))
            .map(|(_, r)| r)
            .collect(),
    )
}

/// The display cap for a custom connection's name, in UTF-16 code units (the
/// unit the TypeScript side and its schemas count). Mirrors
/// `MAX_CUSTOM_CONNECTION_LABEL_CHARS` in `@onecli/agent-protocol` (`text.ts`).
pub const MAX_LABEL_UTF16: usize = 80;

/// What a blank-named custom connection is shown as. Mirrors
/// `CUSTOM_CONNECTION_FALLBACK_LABEL` in `@onecli/agent-protocol`.
pub const FALLBACK_LABEL: &str = "Custom connection";

/// Invisible Unicode format characters (category Cf) that could reorder or
/// hide text: bidi embeddings/overrides/isolates, zero-width chars, LRM/RLM,
/// word joiner, BOM. Mirrors `isFormatChar` in `@onecli/agent-protocol`.
fn is_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
    )
}

/// A secret name made safe to show the agent: control and invisible format
/// characters dropped, whitespace runs collapsed to one space, clamped to
/// [`MAX_LABEL_UTF16`] UTF-16 code units without splitting a character, and
/// [`FALLBACK_LABEL`] when nothing is left. Same output as
/// `customConnectionLabel` on the TypeScript side: both are pinned to the
/// shared `custom-connection-label-cases.json` corpus. (After the filter, the
/// only characters where `char::is_whitespace` and the JS `\s` class differ,
/// U+0085 and U+FEFF, are already gone.)
#[must_use]
pub fn display_label(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        return FALLBACK_LABEL.to_string();
    }
    let mut units = 0;
    cleaned
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_LABEL_UTF16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tagged(id: &str, scope: &str, pattern: &str, inj: Injection) -> InjectionRule {
        InjectionRule {
            path_pattern: pattern.to_string(),
            injections: vec![inj],
            secret: Some(SecretRef {
                id: id.to_string(),
                name: format!("name-{id}"),
                scope: scope.to_string(),
            }),
        }
    }

    fn header(name: &str, value: &str) -> Injection {
        Injection::SetHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    fn ids(rules: &[InjectionRule]) -> Vec<String> {
        rules
            .iter()
            .map(|r| r.secret.as_ref().map_or("-".into(), |s| s.id.clone()))
            .collect()
    }

    fn ambiguous_ids(d: SecretDisambiguation) -> Vec<String> {
        match d {
            SecretDisambiguation::Ambiguous(c) => c.into_iter().map(|s| s.id).collect(),
            SecretDisambiguation::Resolved(r) => panic!("expected ambiguous, got {:?}", ids(&r)),
        }
    }

    fn resolved_ids(d: SecretDisambiguation) -> Vec<String> {
        match d {
            SecretDisambiguation::Resolved(r) => ids(&r),
            SecretDisambiguation::Ambiguous(c) => panic!("expected resolved, got {c:?}"),
        }
    }

    #[test]
    fn same_header_same_scope_is_ambiguous() {
        let rules = vec![
            tagged("a", "workspace", "*", header("X-Api-Key", "1")),
            tagged("b", "workspace", "*", header("x-api-key", "2")),
        ];
        assert_eq!(
            ambiguous_ids(disambiguate_secret_rules(rules, Some("/v1/x"), None)),
            vec!["a", "b"]
        );
    }

    #[test]
    fn different_headers_do_not_conflict() {
        let rules = vec![
            tagged("a", "workspace", "*", header("x-api-key", "1")),
            tagged("b", "workspace", "*", header("x-app-key", "2")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/"), None)),
            vec!["a", "b"]
        );
    }

    #[test]
    fn same_param_collides_and_path_injections_collide() {
        let p = |n: &str| Injection::SetParam {
            name: "key".into(),
            value: n.into(),
        };
        let rules = vec![
            tagged("a", "workspace", "*", p("1")),
            tagged("b", "workspace", "*", p("2")),
        ];
        assert_eq!(
            ambiguous_ids(disambiguate_secret_rules(rules, Some("/"), None)).len(),
            2
        );
        let t = |v: &str| Injection::SetPath {
            template: "/bot{value}".into(),
            value: v.into(),
        };
        let rules = vec![
            tagged("a", "workspace", "*", t("1")),
            tagged("b", "workspace", "*", t("2")),
        ];
        assert_eq!(
            ambiguous_ids(disambiguate_secret_rules(rules, Some("/bot/x"), None)).len(),
            2
        );
    }

    #[test]
    fn workspace_shadows_org() {
        let rules = vec![
            tagged("org", "organization", "*", header("x-api-key", "1")),
            tagged("ws", "workspace", "*", header("x-api-key", "2")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/"), None)),
            vec!["ws"]
        );
    }

    #[test]
    fn pin_can_select_the_shadowed_org_secret() {
        let rules = vec![
            tagged("org", "organization", "*", header("x-api-key", "1")),
            tagged("ws", "workspace", "*", header("x-api-key", "2")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/"), Some("org"))),
            vec!["org"]
        );
    }

    #[test]
    fn most_specific_path_wins() {
        let rules = vec![
            tagged("wide", "workspace", "*", header("x-api-key", "1")),
            tagged("v1", "workspace", "/v1/*", header("x-api-key", "2")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(
                rules.clone(),
                Some("/v1/x"),
                None
            )),
            vec!["v1"]
        );
        // Off the specific path only the catch-all serves: no collision.
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/v2/x"), None)),
            vec!["wide", "v1"]
        );
    }

    #[test]
    fn disjoint_paths_do_not_conflict() {
        let rules = vec![
            tagged("a", "workspace", "/a/*", header("x-api-key", "1")),
            tagged("b", "workspace", "/b/*", header("x-api-key", "2")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/a/1"), None)),
            vec!["a", "b"]
        );
    }

    #[test]
    fn pin_selects_one() {
        let rules = vec![
            tagged("a", "workspace", "*", header("x-api-key", "1")),
            tagged("b", "workspace", "*", header("x-api-key", "2")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/"), Some("b"))),
            vec!["b"]
        );
    }

    #[test]
    fn pin_outside_the_pool_does_not_select() {
        let rules = vec![
            tagged("a", "workspace", "*", header("x-api-key", "1")),
            tagged("b", "workspace", "*", header("x-api-key", "2")),
        ];
        assert!(!rules_name_secret(&rules, "foreign"));
        assert_eq!(
            ambiguous_ids(disambiguate_secret_rules(rules, Some("/"), Some("foreign"))).len(),
            2
        );
    }

    #[test]
    fn untagged_rules_are_never_candidates() {
        // An LLM key and the platform credit carry no tag; two of them on one
        // header are left for their own collapsing logic.
        let llm = InjectionRule {
            path_pattern: "*".into(),
            injections: vec![header("x-api-key", "llm")],
            secret: None,
        };
        let rules = vec![
            llm.clone(),
            llm,
            tagged("a", "workspace", "*", header("x-api-key", "1")),
        ];
        assert_eq!(
            resolved_ids(disambiguate_secret_rules(rules, Some("/"), None)),
            vec!["-", "-", "a"]
        );
    }

    #[test]
    fn colliding_secrets_lists_only_shared_slots() {
        let rules = vec![
            tagged("a", "workspace", "/a/*", header("x-api-key", "1")),
            tagged("b", "workspace", "/b/*", header("X-API-KEY", "2")),
            tagged("c", "workspace", "*", header("x-other", "3")),
        ];
        let ids: Vec<String> = colliding_secrets(&rules)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn display_label_matches_the_shared_corpus() {
        // The SAME cases `customConnectionLabel` asserts on the TS side
        // (packages/agent-protocol/src/text.test.ts). `include_str!` resolves
        // relative to this file (apps/gateway/crates/inject/src/), so five
        // `..` reach the repo root.
        const CORPUS: &str = include_str!(
            "../../../../../packages/agent-protocol/src/custom-connection-label-cases.json"
        );
        #[derive(serde::Deserialize)]
        struct Case {
            raw: String,
            want: String,
        }
        #[derive(serde::Deserialize)]
        struct Corpus {
            max: usize,
            fallback: String,
            cases: Vec<Case>,
        }
        let corpus: Corpus = serde_json::from_str(CORPUS).expect("parse label corpus");
        assert_eq!(corpus.max, MAX_LABEL_UTF16);
        assert_eq!(corpus.fallback, FALLBACK_LABEL);
        assert!(corpus.cases.len() > 10, "corpus unexpectedly small");
        for case in corpus.cases {
            let got = display_label(&case.raw);
            assert_eq!(got, case.want, "{:?}", case.raw);
            assert!(got.encode_utf16().count() <= MAX_LABEL_UTF16);
        }
    }

    #[test]
    fn rule_without_secret_field_deserializes() {
        // A rule cached by a gateway that predates the tag (rolling deploy).
        let old = r#"{"path_pattern":"*","injections":[]}"#;
        let rule: InjectionRule = serde_json::from_str(old).unwrap();
        assert!(rule.secret.is_none());
        // And an untagged rule serializes without the field.
        assert!(!serde_json::to_string(&rule).unwrap().contains("secret"));
    }
}
