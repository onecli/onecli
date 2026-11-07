//! Git smart-HTTP requests (any host): a push (`git-receive-pack`) or a
//! clone/fetch (`git-upload-pack`) carries a pkt-line header followed by a
//! binary PACK. Shown raw it is noise ("00b50000…PACK�x…"), so the approval
//! card says what the push does instead: which branches it creates, updates,
//! or deletes. The PACK is never rendered.

use super::{one_line, ApprovalSummary, SummaryRequest, MAX_VALUE_LEN};

/// Cap on listed ref updates; a push of hundreds of tags stays readable.
const MAX_REFS: usize = 10;

/// `Some` for a git smart-HTTP pack request (always a POST), whatever the
/// provider.
pub(super) fn summarize(req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    if req.method_upper() != "POST" {
        return None;
    }
    let path = req.base_path();
    if let Some(repo) = path.strip_suffix("/git-receive-pack") {
        let mut s = ApprovalSummary::new("Git push");
        push_repository(&mut s, repo);
        let updates = req.body.map(ref_updates).unwrap_or_default();
        if updates.is_empty() {
            s.push("Changes", "Pushes commits to the repository");
        }
        for update in updates.iter().take(MAX_REFS) {
            s.push(update.label(), update.target());
        }
        if updates.len() > MAX_REFS {
            s.push("More", format!("{} more refs", updates.len() - MAX_REFS));
        }
        return Some(s);
    }
    if let Some(repo) = path.strip_suffix("/git-upload-pack") {
        let mut s = ApprovalSummary::new("Git clone / fetch");
        push_repository(&mut s, repo);
        return Some(s);
    }
    None
}

/// The repository is the whole path before the pack service, without its
/// `.git`: `owner/repo` on GitHub and Bitbucket, `group/sub/repo` on GitLab.
fn push_repository(s: &mut ApprovalSummary, repo: &str) {
    let repo = repo.trim_matches('/');
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    s.push("Repository", one_line(repo, MAX_VALUE_LEN));
}

#[derive(Debug, PartialEq, Eq)]
enum RefUpdate {
    Create(String),
    Update(String),
    Delete(String),
}

impl RefUpdate {
    fn label(&self) -> &'static str {
        match self {
            Self::Create(_) => "Creates",
            Self::Update(_) => "Updates",
            Self::Delete(_) => "Deletes",
        }
    }

    fn target(&self) -> String {
        let name = match self {
            Self::Create(r) | Self::Update(r) | Self::Delete(r) => r,
        };
        let name = one_line(name, MAX_VALUE_LEN);
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            format!("branch {branch}")
        } else if let Some(tag) = name.strip_prefix("refs/tags/") {
            format!("tag {tag}")
        } else {
            name
        }
    }
}

/// An object id as git writes it: SHA-1 (40) or SHA-256 (64) hex digits.
fn is_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The all-zero id a command uses for "no ref" (create from, delete to).
fn is_zero_oid(s: &str) -> bool {
    s.bytes().all(|b| b == b'0')
}

/// Parse the receive-pack command list: pkt-lines of
/// `<old-oid> <new-oid> <ref>[\0capabilities]`, after any `shallow <oid>`
/// lines and ending at a flush (`0000`) before the PACK. Stops at anything
/// malformed: the summary never guesses.
fn ref_updates(body: &[u8]) -> Vec<RefUpdate> {
    let mut out = Vec::new();
    let mut rest = body;
    while rest.len() >= 4 {
        // A pkt-line length is exactly four hex digits (`from_str_radix`
        // alone would also take a sign).
        let Some(len) = std::str::from_utf8(&rest[..4])
            .ok()
            .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|h| usize::from_str_radix(h, 16).ok())
        else {
            break;
        };
        if len < 4 || len > rest.len() {
            break; // flush (end of commands) or truncated
        }
        let line = &rest[4..len];
        rest = &rest[len..];
        let line = line.split(|&b| b == 0).next().unwrap_or_default();
        let Ok(text) = std::str::from_utf8(line) else {
            break;
        };
        let text = text.trim_end();
        if text.strip_prefix("shallow ").is_some_and(is_oid) {
            continue;
        }
        let mut fields = text.splitn(3, ' ');
        let (Some(old), Some(new), Some(name)) = (fields.next(), fields.next(), fields.next())
        else {
            break;
        };
        if !is_oid(old) || !is_oid(new) {
            break;
        }
        let name = name.to_string();
        out.push(if is_zero_oid(old) {
            RefUpdate::Create(name)
        } else if is_zero_oid(new) {
            RefUpdate::Delete(name)
        } else {
            RefUpdate::Update(name)
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZERO: &str = "0000000000000000000000000000000000000000";

    fn pkt(line: &str) -> Vec<u8> {
        let mut v = format!("{:04x}", line.len() + 4).into_bytes();
        v.extend_from_slice(line.as_bytes());
        v
    }

    fn req<'a>(method: &'a str, path: &'a str, body: &'a [u8]) -> SummaryRequest<'a> {
        SummaryRequest {
            method,
            path,
            content_type: Some("application/x-git-receive-pack-request"),
            body: Some(body),
        }
    }

    fn push(path: &str, body: &[u8]) -> ApprovalSummary {
        summarize(&req("POST", path, body)).expect("a push is summarized")
    }

    fn rows(s: &ApprovalSummary) -> Vec<(String, String)> {
        s.details
            .iter()
            .map(|d| (d.label.clone(), d.value.clone()))
            .collect()
    }

    #[test]
    fn push_shows_branch_not_pack_bytes() {
        let new = "f5a170a5ef59d345bf477809b746955e15ad8442";
        let mut body = pkt(&format!(
            "{ZERO} {new} refs/heads/feature-x\0report-status-v2 side-band-64k"
        ));
        body.extend_from_slice(b"0000PACK\x00\x00\x00\x02\x9c\xff\x01binary");
        let s = push("/acme/web.git/git-receive-pack", &body);
        assert_eq!(s.action, "Git push");
        assert_eq!(
            rows(&s),
            vec![
                ("Repository".into(), "acme/web".into()),
                ("Creates".into(), "branch feature-x".into()),
            ]
        );
        let text = s.render_text();
        assert!(!text.contains("PACK"));
        assert!(!text.contains(new));
    }

    #[test]
    fn update_and_delete_are_named() {
        let a = "1".repeat(40);
        let b = "2".repeat(40);
        let mut body = pkt(&format!("{a} {b} refs/heads/main\0caps"));
        body.extend(pkt(&format!("{a} {ZERO} refs/tags/v1")));
        body.extend_from_slice(b"0000PACK");
        let s = push("/o/r/git-receive-pack", &body);
        assert_eq!(
            rows(&s)[1..],
            [
                ("Updates".into(), "branch main".into()),
                ("Deletes".into(), "tag v1".into()),
            ]
        );
    }

    /// A SHA-256 repository writes 64-digit ids; a shallow clone's push
    /// leads with `shallow <oid>` lines before its commands.
    #[test]
    fn sha256_ids_and_shallow_lines_are_read() {
        let zero = "0".repeat(64);
        let new = "a".repeat(64);
        let mut body = pkt(&format!("shallow {}", "b".repeat(40)));
        body.extend(pkt(&format!("{zero} {new} refs/heads/feature-x\0caps")));
        body.extend_from_slice(b"0000PACK");
        let s = push("/o/r.git/git-receive-pack", &body);
        assert_eq!(rows(&s)[1], ("Creates".into(), "branch feature-x".into()));
    }

    #[test]
    fn a_long_push_lists_the_first_refs_and_counts_the_rest() {
        let mut body = Vec::new();
        for i in 0..MAX_REFS + 3 {
            body.extend(pkt(&format!("{ZERO} {} refs/tags/v{i}", "1".repeat(40))));
        }
        body.extend_from_slice(b"0000PACK");
        let s = push("/o/r/git-receive-pack", &body);
        assert_eq!(s.details.len(), 1 + MAX_REFS + 1);
        assert_eq!(
            rows(&s).last().unwrap(),
            &("More".into(), "3 more refs".into())
        );
    }

    #[test]
    fn a_ref_name_reads_on_one_line() {
        let body = pkt(&format!("{ZERO} {} refs/heads/a\tb\rc", "1".repeat(40)));
        let s = push("/o/r/git-receive-pack", &body);
        assert_eq!(rows(&s)[1], ("Creates".into(), "branch a b c".into()));
    }

    #[test]
    fn unparseable_push_still_never_shows_bytes() {
        for body in [&b"\x00\x01PACK garbage"[..], b"+04a"] {
            let s = push("/o/r.git/git-receive-pack", body);
            assert_eq!(
                rows(&s),
                vec![
                    ("Repository".into(), "o/r".into()),
                    ("Changes".into(), "Pushes commits to the repository".into()),
                ]
            );
        }
    }

    /// GitLab nests projects in subgroups: the repository is the whole path.
    #[test]
    fn the_repository_is_every_segment_before_the_service() {
        let s = summarize(&req("POST", "/group/sub/web.git/git-upload-pack", b"")).unwrap();
        assert_eq!(s.action, "Git clone / fetch");
        assert_eq!(
            rows(&s),
            vec![("Repository".into(), "group/sub/web".into())]
        );
    }

    #[test]
    fn only_a_pack_post_is_ours() {
        assert!(summarize(&req("GET", "/o/r.git/git-receive-pack", b"")).is_none());
        assert!(summarize(&req(
            "GET",
            "/o/r.git/info/refs?service=git-receive-pack",
            b""
        ))
        .is_none());
        assert!(summarize(&req("POST", "/2.0/repositories/o/r/pullrequests", b"{}")).is_none());
    }
}
