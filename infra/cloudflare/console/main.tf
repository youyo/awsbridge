# コンソールログイン（人の AWS コンソールへのログイン）の入口とチームの Access アプリ。MCP 用の infra/cloudflare とは別のディレクトリ・別の state。
# 設計: docs/specs/console-login.md §5.4・docs/specs/console-login-portal.md §9.1。
#
# R-P（portal.routing: path。既定）の要件: 入口のアプリとすべてのチームのアプリで Cookie Path（path_cookie_attribute）を有効にする。
# 無効だと、同じホストの別のアプリの AUD も Access JWT の aud に入り、Worker の「aud はちょうど 1 つ」の検査で断られる（ログインができなくなる）。
# この例は true に固定し、変数にしない。適用後の値が true でなければ失敗する（postcondition）。
# 実物が要件を満たしているかは mise run console:access:inspect（Cloudflare API を読む）で確かめる。
#
# issuer の文書（/.well-known/*）は別のホスト（例 awsbridge-oidc-console.example.com）で Worker が返す。そのホストにはこの Access のアプリを作らない
# （AWS IAM / STS が認証なしで取りに来る）。ゾーン全体を覆う別の Access アプリがあれば、そのホストを bypass する。

locals {
  hosts = {
    standard = var.standard_host
    admin    = var.admin_host
  }
  session_duration = {
    standard = var.standard_session_duration
    admin    = var.admin_session_duration
  }

  # 入口のアプリを作る階層: Standard は常に、Admin は Admin の階層のチームがあるときだけ。
  entry_tiers = toset(distinct(concat(["standard"], [for t in values(var.teams) : t.tier])))
}

# 入口: ホスト全体。チームのパス（/t/<チーム>）では、より具体的なチームのアプリが優先される。
# Cookie の設定は portal.md §9.1 の推奨（Binding cookie 有効・SameSite は Lax）。
resource "cloudflare_zero_trust_access_application" "entry" {
  for_each = local.entry_tiers

  account_id                 = var.account_id
  name                       = "${var.name}-entry-${each.key}"
  type                       = "self_hosted"
  allowed_idps               = var.allowed_idp_ids
  auto_redirect_to_identity  = length(var.allowed_idp_ids) == 1
  session_duration           = local.session_duration[each.key]
  enable_binding_cookie      = true
  path_cookie_attribute      = true
  same_site_cookie_attribute = "lax"

  destinations = [{ type = "public", uri = local.hosts[each.key] }]
  policies = [
    for i, id in lookup(var.entry_policy_ids, each.key, []) : { id = id, precedence = i + 1 }
  ]

  lifecycle {
    postcondition {
      condition     = self.path_cookie_attribute == true
      error_message = "入口のアプリの Cookie Path（path_cookie_attribute）が有効でない（R-P の要件）。"
    }
  }
}

# チーム: <host>/t/<チーム>。階層のホストの下に置く。
resource "cloudflare_zero_trust_access_application" "team" {
  for_each = var.teams

  account_id                 = var.account_id
  name                       = "${var.name}-${each.key}"
  type                       = "self_hosted"
  allowed_idps               = var.allowed_idp_ids
  auto_redirect_to_identity  = length(var.allowed_idp_ids) == 1
  session_duration           = local.session_duration[each.value.tier]
  enable_binding_cookie      = true
  path_cookie_attribute      = true
  same_site_cookie_attribute = "lax"

  destinations = [{ type = "public", uri = "${local.hosts[each.value.tier]}/t/${each.key}" }]
  policies = [
    for i, id in each.value.policy_ids : { id = id, precedence = i + 1 }
  ]

  lifecycle {
    postcondition {
      condition     = self.path_cookie_attribute == true
      error_message = "チームのアプリの Cookie Path（path_cookie_attribute）が有効でない（R-P の要件）。"
    }
  }
}
