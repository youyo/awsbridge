# PoC（人間のログイン）のポータル用 Access アプリ。MCP 用の infra/cloudflare とは別のディレクトリ・別の state。
# 確かめること（scripts/poc/human/portal/README.md）:
#   N1  同じホストのパス違い（/t/<チーム>）に別々のアプリを作ると、Worker に届く Access JWT の aud が分かれるか。
#       入口（ホスト全体）のアプリより、具体的なパスのアプリが優先されるか。片方のアプリに許可されていない人が拒否されるか
#   N10 所属を外したとき（emails から外す・セッション時間を短くする・トークンを失効させる）に拒否されるまでの時間
# IdP は Google（groups が無い）なので、所属の代わりに email の include を使う。

locals {
  all_emails = sort(distinct(flatten([for t in values(var.teams) : t.emails])))

  # IAM が取りに来る issuer の文書（N9）。Access の外に出す
  issuer_document_paths = flatten([
    for tier in ["std", "admin"] : [
      "${var.worker_host}/${tier}/.well-known/openid-configuration",
      "${var.worker_host}/${tier}/.well-known/jwks.json",
    ]
  ])
}

resource "cloudflare_zero_trust_access_policy" "team" {
  for_each = var.teams

  account_id = var.account_id
  name       = "${var.name}-${each.key}"
  decision   = "allow"
  include    = [for e in each.value.emails : { email = { email = e } }]
}

resource "cloudflare_zero_trust_access_policy" "entry" {
  account_id = var.account_id
  name       = "${var.name}-entry"
  decision   = "allow"
  include    = [for e in local.all_emails : { email = { email = e } }]
}

resource "cloudflare_zero_trust_access_policy" "bypass_everyone" {
  account_id = var.account_id
  name       = "${var.name}-bypass-issuer-documents"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

# 入口: ホスト全体。チームのパスより具体性が低いので、/t/<チーム> ではチームのアプリが優先されるはず（N1 で確かめる）
resource "cloudflare_zero_trust_access_application" "entry" {
  account_id                = var.account_id
  name                      = "${var.name}-entry"
  type                      = "self_hosted"
  allowed_idps              = var.allowed_idp_ids
  auto_redirect_to_identity = length(var.allowed_idp_ids) == 1
  session_duration          = var.entry_session_duration
  enable_binding_cookie     = var.enable_binding_cookie
  path_cookie_attribute     = var.path_cookie_attribute

  destinations = [{ type = "public", uri = var.worker_host }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.entry.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "team" {
  for_each = var.teams

  account_id                = var.account_id
  name                      = "${var.name}-${each.key}"
  type                      = "self_hosted"
  allowed_idps              = var.allowed_idp_ids
  auto_redirect_to_identity = length(var.allowed_idp_ids) == 1
  session_duration          = each.value.session_duration
  enable_binding_cookie     = var.enable_binding_cookie
  path_cookie_attribute     = var.path_cookie_attribute

  destinations = [{ type = "public", uri = "${var.worker_host}/t/${each.key}" }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.team[each.key].id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "issuer_documents" {
  account_id = var.account_id
  name       = "${var.name}-issuer-documents"
  type       = "self_hosted"

  destinations = [for p in local.issuer_document_paths : { type = "public", uri = p }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.bypass_everyone.id, precedence = 1 }]
}
