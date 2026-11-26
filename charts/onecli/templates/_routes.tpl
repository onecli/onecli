{{/*
The one-origin path split, shared by the Ingress and the HTTPRoute:

  /v1, /auth, /scim/v2  → api        (api surface; better-auth lives at /auth)
  /gw                   → gateway    (prefix-stripped: /gw/x → /x)
  the dashboard's own /auth pages → web (exact: /auth/login{,/*}, /auth/signup,
                        /auth/cli, /auth/forgot-password, /auth/reset-password;
                        the dashboard forwards form submits on these to the api
                        itself, so no method rule is needed anywhere)
  /                     → web

The page list mirrors apps/web/src/proxy.ts WEB_AUTH_PAGES; the repo's
scripts/helm-chart.test.mjs pins the two together.
*/}}

{{- define "onecli.routes.webAuthPages" -}}
- /auth/login
- /auth/signup
- /auth/cli
- /auth/forgot-password
- /auth/reset-password
{{- end -}}

{{- define "onecli.routes.apiPrefixes" -}}
- /v1
- /auth
- /scim/v2
{{- end -}}

{{/* The host part of externalUrl (no scheme, no port). */}}
{{- define "onecli.externalHost" -}}
{{- $noScheme := regexReplaceAll "^https?://" .Values.externalUrl "" -}}
{{- regexReplaceAll ":[0-9]+$" $noScheme "" -}}
{{- end -}}
