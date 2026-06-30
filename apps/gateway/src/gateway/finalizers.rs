pub(crate) mod aws_sigv4;
#[cfg(edition_cloud)]
#[path = "../cloud/aws_sts.rs"]
pub(crate) mod aws_sts;
