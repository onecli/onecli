pub(crate) mod aws_sigv4;
#[cfg(feature = "cloud")]
#[path = "../cloud/aws_sts.rs"]
pub(crate) mod aws_sts;
