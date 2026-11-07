# OneCLI Helm chart

OneCLI on Kubernetes: the dashboard, the API, the credential-injecting
gateway, the hosted-agents runner, and (opt-in) the Slack channel adapter.
Each agent sandbox runs as its own Job + PVC in a fenced namespace, with no
Docker daemon anywhere.

It is the Kubernetes counterpart of the [Docker Compose stack](../../docs/self-hosting.md)
and runs the same images with the same configuration. Amazon EKS is the
reference platform; any conformant Kubernetes 1.30+ with a
NetworkPolicy-enforcing CNI works.

## What you get

| Component         | Kind              | Notes                                                                    |
| ----------------- | ----------------- | ------------------------------------------------------------------------ |
| `web`             | Deployment        | The dashboard (Next.js), port 10254                                      |
| `api`             | Deployment        | The one `/v1` server, port 10256. One replica (in-process event bus)     |
| `gateway`         | Deployment        | MITM proxy, port 10255. CA from a Secret, read-only root, no volume      |
| `runner`          | Deployment        | Starts/parks/reaps sandboxes via the Kubernetes API                      |
| `channel-adapter` | Deployment        | Opt-in (`channelAdapter.enabled`). Slack connections, answers, approvals |
| `migrations`      | Job               | `prisma migrate deploy`, one per install/upgrade; the api waits on it    |
| `postgresql`      | StatefulSet       | **Evaluation only.** Bring your own for production                       |
| sandboxes         | Namespace + fence | PSA `restricted`, default-deny NetworkPolicy, quota, LimitRange          |

Every pod runs non-root with all capabilities dropped and the default seccomp
profile, which is what Pod Security Admission `restricted` requires. The
runner is the only pod with a ServiceAccount token, scoped to the sandbox
namespace plus a `get` on three Services.

## Install

### 1. Secrets

Create the application secrets in the release namespace. They are yours to
keep: `SECRET_ENCRYPTION_KEY` encrypts every credential OneCLI stores, and
losing it orphans them all.

```sh
hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
kubectl create namespace onecli
kubectl -n onecli create secret generic onecli-secrets \
  --from-literal=BETTER_AUTH_SECRET="$(head -c 32 /dev/urandom | base64)" \
  --from-literal=SECRET_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)" \
  --from-literal=GATEWAY_INTERNAL_SECRET="$(head -c 32 /dev/urandom | base64)" \
  --from-literal=RUNNER_TOKEN="rnr_$(hex)" \
  --from-literal=RUNNER_SESSION_KEY="k1.$(hex)" \
  --from-literal=CHANNEL_ADAPTER_TOKEN="cha_$(hex)"
```

`RUNNER_SESSION_KEY` lets a runner restart (an upgrade, a node drain) keep
every in-flight agent turn; without it the runner still works, but a
restart ends running turns. `CHANNEL_ADAPTER_TOKEN` is read only when Slack
is on ([Slack](#6-slack)); minting it now makes that a one-flag change.

Any secret manager that materialises a Kubernetes Secret with those keys
(External Secrets Operator, Sealed Secrets, Vault) works the same way: name
it in `secrets.existingSecret`. A Secret made from an older version of this
README lacks the last two keys; add them without touching the others:

```sh
kubectl -n onecli patch secret onecli-secrets --type merge -p \
  "{\"stringData\":{\"RUNNER_SESSION_KEY\":\"k1.$(hex)\",\"CHANNEL_ADAPTER_TOKEN\":\"cha_$(hex)\"}}"
```

For a throwaway evaluation, `secrets.generate.enabled=true` runs a Job that
mints them into `<release>-secrets` instead. It never changes an existing
value; on upgrades it only adds keys a newer chart introduced.

### 2. Database

For production, bring a PostgreSQL 16+ you operate (RDS, Cloud SQL, a
Postgres operator) and hand the chart its URL:

```sh
kubectl -n onecli create secret generic onecli-database \
  --from-literal=DATABASE_URL='postgresql://onecli:PASSWORD@db.example.internal:5432/onecli?sslmode=require'
```

Then set `database.enabled=false` and `database.external.existingSecret=onecli-database`.
The chart refuses to render with both the bundled database and an external
one, or with neither.

The bundled `postgresql` (on by default) is one replica on one PVC with no
backups. It exists so a first install works with nothing else. Do not run
production on it.

### 3. Install

```sh
helm install onecli oci://ghcr.io/onecli/charts/onecli \
  --namespace onecli \
  --set externalUrl=https://onecli.example.com \
  --set secrets.existingSecret=onecli-secrets \
  --set database.enabled=false \
  --set database.external.existingSecret=onecli-database \
  --set httpRoute.enabled=true \
  --set 'httpRoute.parentRefs[0].name=my-gateway'
```

`externalUrl` is the one address people open OneCLI at. Everything else
derives from it: with `https://`, your Ingress or Gateway API route serves
the whole product on one origin and the chart's route splits the paths.

Watch the rollout with `kubectl -n onecli get pods -w`. The api waits for
the migrations Job before it serves; the dashboard and gateway wait for the
api. The first account to sign up owns the install.

### 4. Routing

One origin, split by path:

| Path                                                                                                         | Backend   |
| ------------------------------------------------------------------------------------------------------------ | --------- |
| `/v1`, `/auth`, `/scim/v2`                                                                                   | `api`     |
| `/gw` (prefix-stripped: `/gw/x` reaches the gateway as `/x`)                                                 | `gateway` |
| `/auth/login`, `/auth/login/*`, `/auth/signup`, `/auth/cli`, `/auth/forgot-password`, `/auth/reset-password` | `web`     |
| everything else                                                                                              | `web`     |

Those five `/auth` paths are dashboard pages that share the api's prefix.
The split is by path only: the dashboard forwards the one form submit on
them (`POST /auth/reset-password`) to the api itself, so no method-aware
routing is ever needed.

With Gateway API (`httpRoute.enabled=true`), the chart's HTTPRoute expresses
the prefix strip natively and works on every conformant implementation (EKS
with the AWS Load Balancer Controller, Envoy Gateway, Cilium, Istio). Point
`httpRoute.parentRefs` at your Gateway.

With Ingress (`ingress.enabled=true`), there is no portable prefix strip, so
add your controller's rewrite annotation for `/gw` through
`ingress.annotations`. For ingress-nginx:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/proxy-body-size: 32m
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
```

with the `/gw` path written as `/gw(/|$)(.*)`, which the chart emits when
`ingress.className` is `nginx`.

### 5. Hosted agents

With `runner.enabled` (the default) the runner registers itself with the
api on boot. Each agent gets a Job, a PVC home (`sandboxes.home.size`,
20Gi by default) and a Secret in the `onecli-sandboxes` namespace. The
fence:

- the namespace enforces Pod Security Admission `restricted`
- a default-deny NetworkPolicy, plus egress to the gateway pods (:10255),
  the runner pods (:8484) and cluster DNS only
- the runner refuses to start an agent until it observes the fence enforced:
  an init container must find the api refused and the runner reachable. With
  no NetworkPolicy-enforcing CNI, no agent starts; the fence fails closed

On EKS, enable network policy in the VPC CNI (`enableNetworkPolicy: true`
on the add-on) or run Calico/Cilium. Dedicated nodes for sandboxes are
recommended (`sandboxes.nodeSelector` + `sandboxes.tolerations`), since
agents share a kernel with their neighbours.

Agents reach the internet only through the gateway. To let them reach
internal services (a self-hosted Jira, a private package registry), list
those in `gateway.allowPrivateDestinations`.

### 6. Slack

Agents answer in Slack through the channel adapter, a small daemon that
holds the Slack connections and posts every answer and approval card. It is
off by default; turn it on with:

```sh
helm upgrade onecli oci://ghcr.io/onecli/charts/onecli --namespace onecli \
  --reset-then-reuse-values --set channelAdapter.enabled=true
```

It reads `CHANNEL_ADAPTER_TOKEN` from the application Secret, and the api
reads the same key to admit it. With `secrets.generate.enabled` the Job
mints the key; with your own Secret, the upgrade refuses with the exact
`kubectl patch` when the key is missing. Then
`kubectl -n onecli logs deploy/onecli-channel-adapter` shows `registered`,
and the dashboard's Channels pages stop reporting channels offline.

Argo CD and Flux render with `helm template`, which cannot see your Secret,
so there the check cannot run: add the key before turning the adapter on.
If you add it afterwards, the adapter starts once the key exists but the
api, which read the Secret when it started, still refuses it (the adapter
logs a 401 and restarts); `kubectl -n onecli rollout restart deploy/onecli-api`
fixes it.

The adapter needs no Service, port, database or ServiceAccount token. It
dials the api and gateway Services in-cluster and Slack directly over
outbound 443 (allow `slack.com` and its subdomains if your egress is
filtered: Socket Mode and file uploads use them). Its traffic is platform
traffic, so it never goes through the gateway, and the sandbox fence does
not admit it.

Both Slack transports need it. With an `https://` `externalUrl` new agents
default to Events mode: Slack posts to `/v1/channels/slack/events`, which
the chart's route already sends to the api, and the adapter posts the
replies. Setting up an agent's Slack app is in
[docs/channels-slack.md](../../docs/channels-slack.md).

The optional shared Slack app (team onboarding from Slack) reads four
credentials from a Secret you name in `slackSharedApp.existingSecret`
(`SLACK_SHARED_CLIENT_ID`, `SLACK_SHARED_CLIENT_SECRET`,
`SLACK_SHARED_SIGNING_SECRET`, `SLACK_SHARED_APP_ID`). Most installs skip it.

## Amazon EKS

The chart was tested end to end on EKS Auto Mode (Kubernetes 1.33) with the
AWS Load Balancer Controller's Gateway API support. The cluster needs four
things before `helm install`, none of which the chart can do for you:

1. A default StorageClass. Auto Mode ships none, and the bundled database
   and every agent home are PVCs. Encrypted gp3 is a good default:

   ```yaml
   apiVersion: storage.k8s.io/v1
   kind: StorageClass
   metadata:
     name: auto-ebs-sc
     annotations: { storageclass.kubernetes.io/is-default-class: "true" }
   provisioner: ebs.csi.eks.amazonaws.com
   volumeBindingMode: WaitForFirstConsumer
   parameters: { type: gp3, encrypted: "true" }
   ```

2. Network policy enforcement. Auto Mode's VPC CNI enforces NetworkPolicy
   only after you ask:

   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata: { name: amazon-vpc-cni, namespace: kube-system }
   data: { enable-network-policy-controller: "true" }
   ```

   Auto Mode runs CoreDNS on each node rather than as pods, reachable at
   the service CIDR's `.10`. Find the CIDR with
   `aws eks describe-cluster --query cluster.kubernetesNetworkConfig.serviceIpv4Cidr`
   (for `10.100.0.0/16` the resolver is `10.100.0.10/32`) and hand it to
   `sandboxes.networkPolicy.dns.cidr` so sandboxes can resolve names.

3. Gateway API routing. Auto Mode's built-in load balancing speaks Ingress
   only, with no prefix strip for `/gw`. Install the Gateway API
   CRDs and the [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/gateway/gateway/)
   (v3+, via Pod Identity), then a `GatewayClass` + `Gateway` with an ACM
   certificate on its HTTPS listener. Two controller details are easy to
   miss: target groups must use IP targets (the Services are ClusterIP),
   and the listener certificate goes on a `LoadBalancerConfiguration`, not
   on the Gateway's `certificateRefs`:

   ```yaml
   apiVersion: gateway.k8s.aws/v1
   kind: TargetGroupConfiguration
   metadata: { name: onecli-ip-targets, namespace: onecli }
   spec: { defaultConfiguration: { targetType: ip } }
   ---
   apiVersion: gateway.k8s.aws/v1
   kind: LoadBalancerConfiguration
   metadata: { name: onecli-alb, namespace: onecli }
   spec:
     scheme: internet-facing
     defaultTargetGroupConfiguration: { name: onecli-ip-targets }
     listenerConfigurations:
       - protocolPort: HTTPS:443
         defaultCertificate: arn:aws:acm:REGION:ACCOUNT:certificate/ID
   ---
   apiVersion: gateway.networking.k8s.io/v1
   kind: GatewayClass
   metadata: { name: onecli-alb }
   spec: { controllerName: gateway.k8s.aws/alb }
   ---
   apiVersion: gateway.networking.k8s.io/v1
   kind: Gateway
   metadata: { name: onecli, namespace: onecli }
   spec:
     gatewayClassName: onecli-alb
     infrastructure:
       parametersRef:
         {
           group: gateway.k8s.aws,
           kind: LoadBalancerConfiguration,
           name: onecli-alb,
         }
     listeners:
       - name: https
         protocol: HTTPS
         port: 443
         hostname: onecli.example.com
   ```

   Then `httpRoute.enabled=true` and `httpRoute.parentRefs[0].name=onecli`.
   Point your DNS at the ALB hostname the Gateway reports in
   `status.addresses`.

4. Subnet tags for the controller's subnet discovery:
   `kubernetes.io/role/elb=1` on public subnets (internet-facing ALB) and
   `kubernetes.io/cluster/<name>=shared` on all of them.

## The gateway CA

The gateway terminates TLS for agents with a private CA. The chart mints it
with a one-time Job that runs `onecli-gateway --generate-ca` and stores the
pair in `<release>-gateway-ca`. To supply your own, create a Secret with
`GATEWAY_CA_KEY` and `GATEWAY_CA_CERT` (PEM) and name it in
`gatewayCa.existingSecret`.

Mint it with the gateway binary, never with openssl. The gateway re-signs
its CA on load with its own key-identifier scheme, so a CA minted elsewhere
issues leaf certificates whose authority key identifier never matches, and
every TLS client rejects them. From any machine with Docker:

```sh
docker run --rm -v "$PWD/ca:/mint" ghcr.io/onecli/onecli-gateway:<version> --generate-ca --data-dir /mint
kubectl -n onecli create secret generic onecli-gateway-ca \
  --from-file=GATEWAY_CA_KEY=ca/gateway/ca.key --from-file=GATEWAY_CA_CERT=ca/gateway/ca.pem
```

## Upgrades

```sh
helm upgrade onecli oci://ghcr.io/onecli/charts/onecli --namespace onecli \
  --reset-then-reuse-values
```

`--reset-then-reuse-values` (Helm 3.14+) keeps your settings and picks up
the new chart's defaults for anything you never set. Prefer it to
`--reuse-values`, which replays the previous release's values in place of
the new defaults, so a value a newer chart introduced arrives empty. Even
better, keep your values in a file and pass `-f values.yaml` on every
upgrade.

Each upgrade creates a new migrations Job; the api's init container waits
for the schema to be current. Running agents keep their old image until
they are restarted from the dashboard.

With `migrations.useHelmHooks=true` the Job runs as a pre-upgrade hook
instead: Helm blocks until it completes and fails the release if it fails.
Argo CD and Flux users usually prefer this.

## Uninstall

`helm uninstall onecli` removes everything in the release namespace. The
sandbox namespace and the agents' home PVCs are kept on purpose (they are
customer data): `kubectl delete namespace onecli-sandboxes` when you are
sure.

## Values

Every value is documented in place in [`values.yaml`](values.yaml). The ones
most installs touch:

| Value                              | Default            | What it does                                        |
| ---------------------------------- | ------------------ | --------------------------------------------------- |
| `externalUrl`                      | (required)         | The URL people open OneCLI at                       |
| `secrets.existingSecret`           | `""`               | Your Secret with the application secrets            |
| `secrets.generate.enabled`         | `false`            | Mint them with a Job instead (evaluation)           |
| `database.enabled`                 | `true`             | Bundled PostgreSQL (evaluation only)                |
| `database.external.existingSecret` | `""`               | Your Secret with `DATABASE_URL` (production)        |
| `image.tag`                        | chart `appVersion` | Pin a OneCLI version                                |
| `httpRoute.enabled` / `parentRefs` | `false` / `[]`     | Gateway API route for `externalUrl`                 |
| `ingress.enabled` / `className`    | `false` / `""`     | Ingress for `externalUrl`                           |
| `runner.enabled`                   | `true`             | Hosted agents                                       |
| `runner.maxSandboxes`              | `10`               | Concurrent sandboxes                                |
| `sandboxes.home.size`              | `20Gi`             | Per-agent persistent home                           |
| `sandboxes.memoryMb` / `cpus`      | `2048` / `2`       | Per-sandbox ceiling                                 |
| `sandboxes.nodeSelector`           | `{}`               | Dedicated sandbox nodes                             |
| `gateway.allowPrivateDestinations` | `""`               | Internal hosts agents may reach through the gateway |
| `channelAdapter.enabled`           | `false`            | Slack: agents answer in Slack                       |
| `slackSharedApp.existingSecret`    | `""`               | Your own shared Slack app (team onboarding)         |
| `enterpriseEnabled`                | `false`            | The Enterprise feature set (requires a license)     |

## Enterprise features

Everything above, hosted agents included, works without a license. The
Enterprise feature set (SSO & SCIM, directory groups, RBAC, workspace
sharing, multi-org, spend budgets) is off by default, exactly like the
compose stack's `ENTERPRISE_ENABLED`. With a
[OneCLI Enterprise license](https://onecli.sh), turn it on:

```sh
helm upgrade onecli oci://ghcr.io/onecli/charts/onecli --namespace onecli \
  --reset-then-reuse-values --set enterpriseEnabled=true
```

The api, dashboard and gateway read the flag at startup, so the upgrade
restarts them; running agents are unaffected.

## What the chart does not do

- Scale the api. Self-hosted installs run one api replica (its event bus is
  in-process), and the chart refuses `api.replicas > 1`.
- Scale the gateway without shared state. Pending approvals and the config
  cache live in each gateway's memory, so the chart refuses
  `gateway.replicas > 1` unless `enterpriseEnabled` is on and `REDIS_HOST`
  (the licensed multi-instance stores) is set in `gateway.extraEnv`.
- Expose the raw proxy. The gateway's CONNECT proxy on :10255 stays
  in-cluster, which is where hosted agents reach it. For agents on other
  machines, `gateway.service.type=LoadBalancer` exposes it; a VPN is the
  recommended transport.
- SSH into agents. The SSH front door is not part of this chart yet.
- Back anything up. The bundled database and the agents' homes are plain
  PVCs. Use your platform's snapshot tooling.
