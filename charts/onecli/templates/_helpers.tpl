{{/*
Naming and labels, after the Helm scaffold and the Kubernetes recommended
label set (app.kubernetes.io/*). Resource names are `<release>-<component>`
through `onecli.component`; selectors use the three stable labels only.
*/}}

{{- define "onecli.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "onecli.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* `<fullname>-<component>`, the name of every per-component object. */}}
{{- define "onecli.component" -}}
{{- printf "%s-%s" (include "onecli.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "onecli.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The image tag every OneCLI image uses: an explicit pin, else appVersion. */}}
{{- define "onecli.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{/* `<repository>-<service>:<tag>`; expects {root, service}. */}}
{{- define "onecli.image" -}}
{{- printf "%s-%s:%s" .root.Values.image.repository .service (include "onecli.imageTag" .root) -}}
{{- end -}}

{{/* Common labels for every object; expects the root context. */}}
{{- define "onecli.labels" -}}
helm.sh/chart: {{ include "onecli.chart" . }}
app.kubernetes.io/name: {{ include "onecli.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "onecli.imageTag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: onecli
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Common labels plus the component; expects {root, component}. */}}
{{- define "onecli.componentLabels" -}}
{{ include "onecli.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Selector labels: stable across upgrades (never the chart or app version).
Expects {root, component}.
*/}}
{{- define "onecli.selectorLabels" -}}
app.kubernetes.io/name: {{ include "onecli.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "onecli.annotations" -}}
{{- with .Values.commonAnnotations }}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* ── Secrets ─────────────────────────────────────────────────────────── */}}

{{/* The Secret holding the application secrets (auth, encryption, internal, runner). */}}
{{- define "onecli.secretsName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "onecli.component" (dict "root" . "component" "secrets") -}}
{{- end -}}
{{- end -}}

{{- define "onecli.gatewayCaSecretName" -}}
{{- if .Values.gatewayCa.existingSecret -}}
{{- .Values.gatewayCa.existingSecret -}}
{{- else -}}
{{- include "onecli.component" (dict "root" . "component" "gateway-ca") -}}
{{- end -}}
{{- end -}}

{{/*
Where DATABASE_URL comes from. Bundled: the chart's own `<fullname>-database`
Secret (assembled from database.*). External: the operator's Secret, or the
chart's from `database.external.url`. Exactly one source must be configured.
*/}}
{{- define "onecli.databaseSecretName" -}}
{{- if .Values.database.enabled -}}
{{- include "onecli.component" (dict "root" . "component" "database") -}}
{{- else if .Values.database.external.existingSecret -}}
{{- .Values.database.external.existingSecret -}}
{{- else -}}
{{- include "onecli.component" (dict "root" . "component" "database") -}}
{{- end -}}
{{- end -}}

{{/* The bundled database's in-cluster URL. */}}
{{- define "onecli.bundledDatabaseUrl" -}}
{{- printf "postgresql://%s:%s@%s:5432/%s" .Values.database.user .Values.database.password (include "onecli.component" (dict "root" . "component" "postgresql")) .Values.database.name -}}
{{- end -}}

{{/* ── Validation ───────────────────────────────────────────────────────── */}}

{{- define "onecli.validate" -}}
{{- if not .Values.externalUrl -}}
{{- fail "externalUrl is required: the URL people open OneCLI at, e.g. https://onecli.example.com" -}}
{{- end -}}
{{- if not (regexMatch "^https?://[^/]+$" .Values.externalUrl) -}}
{{- fail (printf "externalUrl must be scheme://host[:port] with no path (got %q)" .Values.externalUrl) -}}
{{- end -}}
{{- if and (hasPrefix "http://" .Values.externalUrl) (not .Values.allowInsecureExternalUrl) -}}
{{- fail "externalUrl must be https://: on Kubernetes the api and gateway are reached through your Ingress/HTTPRoute on the same origin (proxy mode), and an http:// URL would advertise them on host ports that nothing serves. For a port-forward-only trial set allowInsecureExternalUrl=true" -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.generate.enabled) -}}
{{- fail "set secrets.existingSecret to a Secret holding BETTER_AUTH_SECRET, SECRET_ENCRYPTION_KEY, GATEWAY_INTERNAL_SECRET and RUNNER_TOKEN (see the README), or opt in to secrets.generate.enabled for an evaluation install" -}}
{{- end -}}
{{- if not .Values.database.enabled -}}
{{- if and .Values.database.external.existingSecret .Values.database.external.url -}}
{{- fail "database.external.existingSecret and database.external.url are mutually exclusive: set one" -}}
{{- end -}}
{{- if and (not .Values.database.external.existingSecret) (not .Values.database.external.url) -}}
{{- fail "database.enabled is false: set database.external.existingSecret (a Secret with a DATABASE_URL key) or database.external.url" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.database.enabled (or .Values.database.external.existingSecret .Values.database.external.url) -}}
{{- fail "database.enabled is true (the bundled PostgreSQL) but database.external.* is also set: pick one" -}}
{{- end -}}
{{- if ne (int .Values.api.replicas) 1 -}}
{{- fail "api.replicas must be 1 on a self-hosted install: the api's event bus is in-process" -}}
{{- end -}}
{{- end -}}

{{/* ── Pod hardening shared by every OneCLI pod ─────────────────────────── */}}

{{/* PSA `restricted` compliant pod securityContext; expects {uid, gid}. */}}
{{- define "onecli.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .gid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "onecli.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .readOnlyRootFilesystem | default false }}
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* The release namespace's in-cluster service URLs. */}}
{{- define "onecli.apiUrl" -}}
http://{{ include "onecli.component" (dict "root" . "component" "api") }}:10256
{{- end -}}

{{- define "onecli.gatewayUrl" -}}
http://{{ include "onecli.component" (dict "root" . "component" "gateway") }}:10255
{{- end -}}

{{/* The gateway's in-cluster host:port, as agents are told to dial it. */}}
{{- define "onecli.agentProxyAddress" -}}
{{ include "onecli.component" (dict "root" . "component" "gateway") }}:10255
{{- end -}}

{{/* Env shared by api, web and gateway: the public URL and its derivations. */}}
{{- define "onecli.publicUrlEnv" -}}
- name: ONECLI_EXTERNAL_URL
  value: {{ .Values.externalUrl | quote }}
{{- with .Values.trustedOrigins }}
- name: ONECLI_TRUSTED_ORIGINS
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* Flag env shared by api, web and gateway. */}}
{{- define "onecli.flagsEnv" -}}
- name: ENTERPRISE_ENABLED
  value: {{ .Values.enterpriseEnabled | ternary "true" "" | quote }}
{{- end -}}

{{- define "onecli.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* A map rendered as `k=v,k=v` (the runner's RUNNER_KUBE_NODE_SELECTOR shape). */}}
{{- define "onecli.keyValues" -}}
{{- $pairs := list -}}
{{- range $k, $v := . -}}
{{- $pairs = append $pairs (printf "%s=%s" $k $v) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end -}}
