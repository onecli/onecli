import type { AppDefinition } from "./types";

export const jfrogArtifactory: AppDefinition = {
  id: "jfrog-artifactory",
  name: "JFrog Artifactory",
  icon: "/icons/jfrog.svg",
  darkIcon: "/icons/jfrog-light.svg",
  description:
    "Pull npm, PyPI, and other packages through your JFrog Artifactory instance.",
  connectionMethod: {
    type: "api_key",
    // Token MUST come first: the connect handler treats fields[0] as the
    // access token (credentials.access_token = fields[0]). Subdomain second.
    fields: [
      {
        name: "token",
        label: "Access Token",
        description:
          "A JFrog access token with read+deploy on your remote repos.",
        placeholder: "eyJ…",
        secret: true,
      },
      {
        name: "subdomain",
        label: "JFrog Host",
        description: "Your JFrog host, e.g. nanos.jfrog.io",
        placeholder: "nanos.jfrog.io",
        secret: false,
      },
    ],
    // Echo the subdomain as the connection label. No network call — a bad
    // token/host fails lazily at first use, not at connect time.
    resolveMetadata: async (fields) => ({
      name: fields.subdomain,
      username: fields.subdomain,
    }),
  },
  blocklist: [
    { id: "npm", name: "npm Registry", hostPattern: "registry.npmjs.org" },
    { id: "pypi", name: "PyPI", hostPattern: "pypi.org" },
  ],
  labelHint: 'e.g. "nanos.jfrog.io"',
  available: true,
};
