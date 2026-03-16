# Changelog

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
