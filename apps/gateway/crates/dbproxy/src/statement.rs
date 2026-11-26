//! What a statement does, in the terms the policy engine already speaks.
//!
//! The engine judges requests by host, method and path. A database statement
//! has none of those, so each [`StatementClass`] maps to one fixed synthetic
//! request on the connection's own policy host. That mapping is the contract
//! the permission catalog is written against: the app's tools and a grant's
//! read/write split (`GET,HEAD` versus everything else) then govern
//! statements exactly as they govern HTTP calls, with no new policy concept.

/// What a statement the policy judges does to the database, from least to
/// most powerful.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StatementClass {
    /// Reads data and nothing else, provably.
    Read,
    /// Writes data, or calls something the gateway cannot prove pure.
    Write,
    /// Changes the schema, privileges or physical storage (`CREATE`, `ALTER`,
    /// `DROP`, `GRANT`, `TRUNCATE`, `VACUUM`), runs arbitrary server-side
    /// code, or is a statement the classifier does not recognize (fail
    /// closed, at the strictest class).
    Schema,
}

impl StatementClass {
    /// The synthetic request this class is judged as: `(method, path)`.
    /// Reads are `GET`, so a grant's "reads only" filter (`GET,HEAD`) admits
    /// them and nothing else; every other class is a non-read method.
    #[must_use]
    pub fn policy_request(self) -> (&'static str, &'static str) {
        match self {
            Self::Read => ("GET", "/sql/read"),
            Self::Write => ("POST", "/sql/write"),
            Self::Schema => ("POST", "/sql/schema"),
        }
    }

    /// Short human label for logs, errors and approval cards.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Schema => "schema change",
        }
    }
}

/// How a classifier sees one unit of client work (one or more statements
/// the client sends together, or one execution of a prepared statement).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classified {
    /// Session and transaction housekeeping that touches no data (`BEGIN`,
    /// `COMMIT`, `SHOW`, a harmless `SET`, preparing a statement without
    /// running it). Never judged: refusing it would break every client's
    /// handshake, and it can do nothing a judged statement could not.
    Housekeeping,
    /// Policy decides, by the strictest class in the unit.
    Judged(StatementClass),
    /// Refused whatever the policy says: the unit would leave the session the
    /// gateway governs (running programs on the server, reading its files,
    /// switching identity). The reason is shown to the agent.
    Forbidden(&'static str),
    /// The engine's own parser rejected the text, so nothing about it can be
    /// checked. It is not sent; the agent gets the parser's error, as the
    /// server would have answered.
    Unparseable(String),
}

impl Classified {
    /// The verdict for two parts of one unit. A server parses a whole unit
    /// before running any of it, so an unparseable part rejects the unit;
    /// then a forbidden part forbids it; otherwise the strictest judged class
    /// wins.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (bad @ Self::Unparseable(_), _) | (_, bad @ Self::Unparseable(_)) => bad,
            (forbidden @ Self::Forbidden(_), _) | (_, forbidden @ Self::Forbidden(_)) => forbidden,
            (Self::Housekeeping, other) | (other, Self::Housekeeping) => other,
            (Self::Judged(a), Self::Judged(b)) => Self::Judged(a.max(b)),
        }
    }
}

/// The policy host a connection's statements are judged under.
#[must_use]
pub fn policy_host(connection_id: &str, zone: &str) -> String {
    format!("{connection_id}{zone}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_order_from_least_to_most_powerful() {
        use StatementClass::*;
        assert!(Read < Write && Write < Schema);
    }

    /// The contract with the grants compiler: reads ride `GET`, which a
    /// "reads only" filter admits, and nothing else does.
    #[test]
    fn only_reads_are_read_methods_and_every_class_is_its_own_request() {
        use StatementClass::*;
        assert_eq!(Read.policy_request().0, "GET");
        for class in [Write, Schema] {
            assert_ne!(class.policy_request().0, "GET", "{class:?}");
        }
        let paths: std::collections::HashSet<_> = [Read, Write, Schema]
            .iter()
            .map(|c| c.policy_request().1)
            .collect();
        assert_eq!(paths.len(), 3);
    }

    #[test]
    fn a_unit_takes_its_strictest_part() {
        use Classified::*;
        use StatementClass::*;
        assert_eq!(Judged(Read).combine(Judged(Write)), Judged(Write));
        assert_eq!(Judged(Schema).combine(Judged(Read)), Judged(Schema));
        assert_eq!(Housekeeping.combine(Judged(Read)), Judged(Read));
        assert_eq!(Housekeeping.combine(Housekeeping), Housekeeping);
        assert_eq!(Judged(Read).combine(Forbidden("no")), Forbidden("no"));
        assert_eq!(Forbidden("no").combine(Judged(Schema)), Forbidden("no"));
        let bad = Unparseable("syntax error".into());
        assert_eq!(Forbidden("no").combine(bad.clone()), bad);
        assert_eq!(bad.clone().combine(Housekeeping), bad);
    }

    #[test]
    fn the_policy_host_is_the_connection_in_its_zone() {
        assert_eq!(
            policy_host("c1", ".postgres.onecli.invalid"),
            "c1.postgres.onecli.invalid"
        );
    }
}
