# Changelog

## [1.5.2](https://github.com/onecli/onecli/compare/v1.5.1...v1.5.2) (2026-03-23)


### Bug Fixes

* auth login flow, schema migrations, and UI updates ([#88](https://github.com/onecli/onecli/issues/88)) ([a05fedd](https://github.com/onecli/onecli/commit/a05feddc8b40e66eb00344e0896d787e42d89130))

## [1.5.1](https://github.com/onecli/onecli/compare/v1.5.0...v1.5.1) (2026-03-23)


### Bug Fixes

* redesign rule dialog with two-step flow and brand colors ([#85](https://github.com/onecli/onecli/issues/85)) ([296d878](https://github.com/onecli/onecli/commit/296d878b11d1f055e1e2971d9ef256c856390a5a))
* restructure settings with sub-navigation and reorder main nav ([#87](https://github.com/onecli/onecli/issues/87)) ([a1e6f3a](https://github.com/onecli/onecli/commit/a1e6f3af0b01b756a9fd097deeeeab08f486a21b))

## [1.5.0](https://github.com/onecli/onecli/compare/v1.4.2...v1.5.0) (2026-03-22)


### Features

* add rate limit policy rules ([#84](https://github.com/onecli/onecli/issues/84)) ([f2109c2](https://github.com/onecli/onecli/commit/f2109c21ec4b6ffa629d81ae9cc16ae74d1e25e4))


### Bug Fixes

* add loading states to sign-in, sign-out, and demo dialog ([#82](https://github.com/onecli/onecli/issues/82)) ([2fc30b4](https://github.com/onecli/onecli/commit/2fc30b402700285828b353eaf82209241337016a))

## [1.4.2](https://github.com/onecli/onecli/compare/v1.4.1...v1.4.2) (2026-03-22)


### Bug Fixes

* rename indexes and foreign keys to snake_case ([#81](https://github.com/onecli/onecli/issues/81)) ([bc9705c](https://github.com/onecli/onecli/commit/bc9705c1d362537d124ab99d7d45cc88db4f9f7c))
* route all server output through pino JSON in production ([#79](https://github.com/onecli/onecli/issues/79)) ([1d91ad1](https://github.com/onecli/onecli/commit/1d91ad110c4009a3c5a85a7a918e727079521ea7))

## [1.4.1](https://github.com/onecli/onecli/compare/v1.4.0...v1.4.1) (2026-03-20)


### Bug Fixes

* install OpenSSL dev headers in Docker build for ap-* crates ([#74](https://github.com/onecli/onecli/issues/74)) ([ebaf1e1](https://github.com/onecli/onecli/commit/ebaf1e17a2750f19dc12f04326ae08f5d580a6c6))

## [1.4.0](https://github.com/onecli/onecli/compare/v1.3.0...v1.4.0) (2026-03-20)


### Features

* Bitwarden vault support ([#60](https://github.com/onecli/onecli/issues/60)) ([8bdc9e2](https://github.com/onecli/onecli/commit/8bdc9e2095383d6f32c22bb5c55b55220ce86d9f))


### Bug Fixes

* add /api/auth/session endpoint for reliable user provisioning ([#71](https://github.com/onecli/onecli/issues/71)) ([0b8591e](https://github.com/onecli/onecli/commit/0b8591ed519576fa9d720951f0ece609213b1a72))

## [1.3.0](https://github.com/onecli/onecli/compare/v1.2.1...v1.3.0) (2026-03-19)


### Features

* add policy rules for gateway access control ([#66](https://github.com/onecli/onecli/issues/66)) ([2bfe568](https://github.com/onecli/onecli/commit/2bfe568886bd5334ec1811845024482cca552fbe))


### Bug Fixes

* use 127.0.0.1 in health check and reduce image size ([#68](https://github.com/onecli/onecli/issues/68)) ([aa0ca78](https://github.com/onecli/onecli/commit/aa0ca78748badd59351dbdbc443f7fe0d8c38e02))

## [1.2.1](https://github.com/onecli/onecli/compare/v1.2.0...v1.2.1) (2026-03-19)


### Bug Fixes

* add start_period and increase retries for postgres health check ([#63](https://github.com/onecli/onecli/issues/63)) ([789d285](https://github.com/onecli/onecli/commit/789d285e032dfe1b0dc69666613feee4133a6722))
* increase health check start_period for migrations ([#65](https://github.com/onecli/onecli/issues/65)) ([077fe84](https://github.com/onecli/onecli/commit/077fe84c84be14ab601a5d219103de3eb90bb05d))

## [1.2.0](https://github.com/onecli/onecli/compare/v1.1.6...v1.2.0) (2026-03-18)


### Features

* add per-agent secret permissions with selective mode ([#56](https://github.com/onecli/onecli/issues/56)) ([7d47647](https://github.com/onecli/onecli/commit/7d47647a832b1ee933e7c62b5e90b7dd207996db))
* default new agents to selective mode with anthropic secret ([#58](https://github.com/onecli/onecli/issues/58)) ([f7dbe7d](https://github.com/onecli/onecli/commit/f7dbe7de6cae7ab27d2a1de00c6708b07000f17e))


### Bug Fixes

* detect Anthropic auth mode from secret metadata for correct container env vars ([#61](https://github.com/onecli/onecli/issues/61)) ([2e42480](https://github.com/onecli/onecli/commit/2e42480597fd54c43f6214f69ade08f8317dac08))
* scope container-config anthropic secret lookup to agent's secret mode ([#62](https://github.com/onecli/onecli/issues/62)) ([1a794b7](https://github.com/onecli/onecli/commit/1a794b707a21f48b0efa6a7d5c2a3fcb9c406a39))

## [1.1.6](https://github.com/onecli/onecli/compare/v1.1.5...v1.1.6) (2026-03-16)


### Bug Fixes

* add gateway auth extractor, CORS, and user_id threading ([#52](https://github.com/onecli/onecli/issues/52)) ([98d071e](https://github.com/onecli/onecli/commit/98d071e8a98996e790e8f2c9f558c3ada10418bd))

## [1.1.5](https://github.com/onecli/onecli/compare/v1.1.4...v1.1.5) (2026-03-16)


### Bug Fixes

* add explicit bridge network to Docker Compose for reliable DNS resolution ([#49](https://github.com/onecli/onecli/issues/49)) ([369a0b5](https://github.com/onecli/onecli/commit/369a0b5e7eca9d7c7899d6a86a068705b944e03e))
* migrate gateway to Axum with direct DB access ([#46](https://github.com/onecli/onecli/issues/46)) ([d76445f](https://github.com/onecli/onecli/commit/d76445f5f7961afe1639c85abcc9fb29373e6475))
* remove unused gateway connect API route and shared secret ([#48](https://github.com/onecli/onecli/issues/48)) ([ed5e9a3](https://github.com/onecli/onecli/commit/ed5e9a3ebb0373a92dd845b5504f83915f63fbee))

## [1.1.4](https://github.com/onecli/onecli/compare/v1.1.3...v1.1.4) (2026-03-15)


### Bug Fixes

* seed default agent, demo secret, and API key on first dashboard load ([#44](https://github.com/onecli/onecli/issues/44)) ([0fca413](https://github.com/onecli/onecli/commit/0fca413ccf4d921e41ceb0fde13799c7b4f32be3))

## [1.1.3](https://github.com/onecli/onecli/compare/v1.1.2...v1.1.3) (2026-03-15)


### Bug Fixes

* add Discord link to README ([#39](https://github.com/onecli/onecli/issues/39)) ([4bb22ce](https://github.com/onecli/onecli/commit/4bb22ce420cf8b1fccf61a7b96d53715da394e12))
* enforce server-side session validation in all server actions ([#42](https://github.com/onecli/onecli/issues/42)) ([1232b51](https://github.com/onecli/onecli/commit/1232b51790090adb0abce7942759ac149d39d42d))
* replace embedded PGlite with PostgreSQL ([#43](https://github.com/onecli/onecli/issues/43)) ([db44f62](https://github.com/onecli/onecli/commit/db44f6215c0836625d568f93917ae36cf0cdf773))

## [1.1.2](https://github.com/onecli/onecli/compare/v1.1.1...v1.1.2) (2026-03-12)


### Bug Fixes

* correct encryption key generation command for zsh compatibility ([#34](https://github.com/onecli/onecli/issues/34)) ([f5ade32](https://github.com/onecli/onecli/commit/f5ade321fd9f357fb6a9aac4b5a99f83fd57b1af))
* update README with how-it-works section and copy cleanup ([#35](https://github.com/onecli/onecli/issues/35)) ([e43ca55](https://github.com/onecli/onecli/commit/e43ca55f7153bf69231dacf8507137b4e6194e2b))

## [1.1.1](https://github.com/onecli/onecli/compare/v1.1.0...v1.1.1) (2026-03-12)


### Bug Fixes

* add mise config, page header, and profile page ([#31](https://github.com/onecli/onecli/issues/31)) ([b984043](https://github.com/onecli/onecli/commit/b98404346c82927a7268e46b2dfe7f1be86386e0))

## [1.1.0](https://github.com/onecli/onecli/compare/v1.0.3...v1.1.0) (2026-03-12)


### Features

* add 'Try it' demo button in dashboard header ([#23](https://github.com/onecli/onecli/issues/23)) ([221cb6c](https://github.com/onecli/onecli/commit/221cb6c25f4dfc9e8852f4cf450d87e0d2a7ae19))


### Bug Fixes

* crop excess whitespace from logo animations ([#27](https://github.com/onecli/onecli/issues/27)) ([3d1d39a](https://github.com/onecli/onecli/commit/3d1d39a7c6aa7f9ddb868220f83204afcc977c74))

## [1.0.3](https://github.com/onecli/onecli/compare/v1.0.2...v1.0.3) (2026-03-12)


### Bug Fixes

* add setup error page with proxy-based config validation ([#21](https://github.com/onecli/onecli/issues/21)) ([4557579](https://github.com/onecli/onecli/commit/4557579032e650c11950d5c01aa74e4487dc15e4))

## [1.0.2](https://github.com/onecli/onecli/compare/v1.0.1...v1.0.2) (2026-03-11)


### Bug Fixes

* improve Docker publish performance with native ARM builds and cargo-chef ([#19](https://github.com/onecli/onecli/issues/19)) ([c7b02c2](https://github.com/onecli/onecli/commit/c7b02c24d6c3141c2ccd761c506d54a0f666353c))

## [1.0.1](https://github.com/onecli/onecli/compare/v1.0.0...v1.0.1) (2026-03-11)


### Bug Fixes

* add anthropic place holders ([#17](https://github.com/onecli/onecli/issues/17)) ([a359a26](https://github.com/onecli/onecli/commit/a359a26914932251cd44d0c9b8da7edea8a791bb))

## 1.0.0 (2026-03-11)


### Features

* add user API key, Docker setup, rename cognitoId ([#7](https://github.com/onecli/onecli/issues/7)) ([ebff179](https://github.com/onecli/onecli/commit/ebff179b5a680afbd5bdbf033510999ccd63a6be))
* remove unnecessary imp ([#8](https://github.com/onecli/onecli/issues/8)) ([17153bc](https://github.com/onecli/onecli/commit/17153bc9055192bb61c298d5a3bd3bc66defa8ba))
* runtime auth mode detection and auto-generated secrets ([#11](https://github.com/onecli/onecli/issues/11)) ([5c85631](https://github.com/onecli/onecli/commit/5c856317b23961ab65833dca973d162716c350e4))
* unify auth around agent tokens, add secrets ([#5](https://github.com/onecli/onecli/issues/5)) ([76ba39f](https://github.com/onecli/onecli/commit/76ba39f65cd8535c2612a5d426fa0e62e8047bac))


### Bug Fixes

* add release ([#13](https://github.com/onecli/onecli/issues/13)) ([f435bc3](https://github.com/onecli/onecli/commit/f435bc326d1ba25197a83dbcfb2306822e8dd66f))
* build ([#1](https://github.com/onecli/onecli/issues/1)) ([8de12d1](https://github.com/onecli/onecli/commit/8de12d18b806a2e91f2283f9f2867708a6e46287))
* claude md ([#2](https://github.com/onecli/onecli/issues/2)) ([fb4b528](https://github.com/onecli/onecli/commit/fb4b5285c4318bc943ab11f5152c4b1aa2280089))
* claude md ([#3](https://github.com/onecli/onecli/issues/3)) ([e9083fe](https://github.com/onecli/onecli/commit/e9083fe397a7663369bf3c2404d6eefbd77d4adc))
* initial ([bef6893](https://github.com/onecli/onecli/commit/bef689300d1dbe7ba5948ca23658c2727fc1b23a))
* **proxy:** improve auth handling and OAuth token detection ([#9](https://github.com/onecli/onecli/issues/9)) ([6443779](https://github.com/onecli/onecli/commit/644377991db82aa2e0cc8f63fc51a24695547907))
