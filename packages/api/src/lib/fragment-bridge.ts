/**
 * Generates a minimal HTML page that extracts a token from the URL fragment
 * and resubmits it as a query parameter. Used for OAuth providers (e.g., Trello)
 * that return the access token in the hash (#token=...) instead of as a query
 * parameter (?code=...). Fragments are browser-only — servers never receive them.
 */
export const buildFragmentBridgeHtml = (
  paramName: string,
  errorRedirectUrl: string,
): string => `<!DOCTYPE html>
<html>
<head><title>Connecting...</title></head>
<body>
<script>
(function() {
  var hash = window.location.hash.substring(1);
  var match = hash.match(/${paramName}=([^&]+)/);
  if (match) {
    window.location.replace(
      window.location.pathname + "?" + "${paramName}=" + encodeURIComponent(match[1])
    );
  } else {
    window.location.replace(${JSON.stringify(errorRedirectUrl)});
  }
})();
</script>
</body>
</html>`;
