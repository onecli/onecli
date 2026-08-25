# Google Service Account — Review Round 3

> Date: 2026-07-06

## Review Item 1: キャッシュキーのハッシュ対象を `encrypted_value` → `decrypted_json` に変更

### 指摘

1Passwordソースの SA シークレットは `encrypted_value` が `None`（→ `""` にフォールバック）。全OP SA秘密で `sha256("")` が同一定数になり、1Password側でキーをローテーションしてもキャッシュが最大50分失効しない。

### 検証結果: **バグ確認 — 修正必要**

#### 現状のフロー

```
connect.rs:341  let encrypted = secret.encrypted_value.as_deref().unwrap_or("");
connect.rs:342  resolve_google_sa_token(cache, &value, &secret.id, encrypted)
                                                                     ^^^^^^^^^ 1Passwordソースでは常に ""

secret_inject.rs:299  let value_hash = &sha256_hex(encrypted_value)[..16];
                                                   ^^^^^^^^^^^^^^^^ sha256("") = 固定値
```

- `secret_id` が異なるので **異なるSA間での衝突はない**
- しかし **同一SA秘密** の1Password側でのキーローテーション時に、キャッシュキーが変わらず **最大50分古いトークンが使われる**

#### 修正方針

`sha256_hex(encrypted_value)` → `sha256_hex(decrypted_json)` に変更する。

- `decrypted_json` は既に `resolve_google_sa_token()` の引数に存在する
- SHA-256は不可逆なのでキー素材の漏洩リスクなし
- inline/1Passwordどちらのソースでもローテーション即失効になる

#### 必要な変更

**`apps/gateway/src/secret_inject.rs`:**

```rust
// Before:
pub(crate) async fn resolve_google_sa_token(
    cache: &dyn CacheStore,
    decrypted_json: &str,
    secret_id: &str,
    encrypted_value: &str,      // ← 削除
) -> Option<String> {

// After:
pub(crate) async fn resolve_google_sa_token(
    cache: &dyn CacheStore,
    decrypted_json: &str,
    secret_id: &str,
) -> Option<String> {
```

```rust
// Before (line 299):
let value_hash = &sha256_hex(encrypted_value)[..16];

// After:
let value_hash = &sha256_hex(decrypted_json)[..16];
```

**`apps/gateway/src/connect.rs`:**

```rust
// Before (lines 341-346):
let encrypted = secret.encrypted_value.as_deref().unwrap_or("");
match secret_inject::resolve_google_sa_token(
    self.cache.as_ref(),
    &value,
    &secret.id,
    encrypted,
)

// After:
match secret_inject::resolve_google_sa_token(
    self.cache.as_ref(),
    &value,
    &secret.id,
)
```

#### テストへの影響

`secret_inject.rs` のテストで `encrypted_value` パラメータを使用している箇所を更新:

- `resolve_google_sa_token_with()` のシグネチャから `encrypted_value` を削除
- テストケース `resolve_google_sa_token_cache_key_changes_on_rotation` を `decrypted_json` の変更でキーが変わることの検証に修正

---

## Review Item 2: `updateSecret` の 1Password 切り替え時に SA の hostPattern を上書き

### 指摘

`secret-service.ts:352-353` で 1Password ソースに切り替えた際、`data.hostPattern = "www.googleapis.com"` とハードコードで上書きしている。2つの問題:

1. `GOOGLE_SA_DEFAULT_HOST` 定数を使わずハードコード文字列
2. ユーザーが設定済みのカスタム hostPattern（例: `storage.googleapis.com`）を黙って上書き

### 検証結果: **バグ確認 — 修正必要**

#### 現状のコード

```typescript
// secret-service.ts:350-353
if (secret.type === "anthropic") data.hostPattern = "api.anthropic.com";
if (secret.type === "openai") data.hostPattern = "api.openai.com";
if (secret.type === "google_service_account")
  data.hostPattern = "www.googleapis.com"; // ← 問題
```

#### anthropic/openai と SA の違い

- **anthropic**: ホストは常に `api.anthropic.com` — 固定。上書きが正当。
- **openai**: ホストは常に `api.openai.com` — 固定。上書きが正当。
- **SA**: ユーザーが `storage.googleapis.com` や `sheets.googleapis.com` など **カスタム設定可能な設計**。上書きは意図に反する。

#### シナリオ

1. ユーザーが SA シークレットを `hostPattern: "storage.googleapis.com"` で作成
2. 後から値のソースを 1Password に切り替え
3. → `hostPattern` が黙って `www.googleapis.com` にリセットされる
4. → `storage.googleapis.com` へのリクエストにトークンが注入されなくなる

#### 修正方針

SA の場合、1Password 切り替え時に `hostPattern` を上書きしない（既存値を保持する）。

**`packages/api/src/services/secret-service.ts`:**

```typescript
// Before:
if (secret.type === "google_service_account")
  data.hostPattern = "www.googleapis.com";

// After: SA では既存の hostPattern を保持（上書きしない）
// anthropic/openai は固定ホストなので上書きが正当だが、
// SA はユーザーがカスタム hostPattern を設定可能な設計。
// 削除するだけでよい。
```

注: `input.hostPattern` が明示的に渡された場合は、後続の `if (input.hostPattern !== undefined)` ブロック（line 383-388）で正しく処理される。

#### テストへの影響

```typescript
// Before (secret-service.test.ts:279-289):
it("defaults hostPattern to www.googleapis.com when switching to 1Password", ...)
  expect(data.hostPattern).toBe("www.googleapis.com");

// After:
it("preserves existing hostPattern when switching to 1Password", ...)
  expect(data.hostPattern).toBeUndefined(); // 既存値を保持（上書きしない）
```

#### 補足: ハードコード文字列

仮に上書き動作を残す場合でも、`"www.googleapis.com"` → `GOOGLE_SA_DEFAULT_HOST` 定数に置き換えるべき。validation 層（`secret.ts:257`）は既に定数を使用している。

---

## Summary

| #   | 指摘                                              | 判定     | アクション |
| --- | ------------------------------------------------- | -------- | ---------- |
| 1   | キャッシュキー `encrypted_value`→`decrypted_json` | バグ確認 | 修正必要   |
| 2   | 1Password切替時のSA hostPattern上書き             | バグ確認 | 修正必要   |
