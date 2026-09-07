/**
 * Channel error vocabulary — the base class now lives in `@onecli/channels`
 * (both runtimes need it below the api). Re-exported here so the api's
 * internal importers keep one conventional path; new code may import from
 * either.
 */
export { ChannelProviderApiError } from "@onecli/channels";
