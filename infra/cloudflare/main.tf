locals {
  mcp_url = "https://${var.worker_host}/mcp"

  # mcp 型・mcp_portal 型のアプリは MCP クライアントが別オリジンから呼ぶので CORS を開ける。
  mcp_cors_headers = {
    allow_all_headers = true
    allow_all_methods = true
    allow_all_origins = true
  }

  policies = [
    for i, id in var.access_policy_ids : {
      id         = id
      precedence = i + 1
    }
  ]
}

check "portal_hostname_required" {
  assert {
    condition     = !var.create_portal || var.portal_hostname != null
    error_message = "create_portal = true のときは portal_hostname を指定する。"
  }
}

# 1. Worker 本体を守る self-hosted アプリ。直 URL でのアクセスを Access で塞ぎ、Worker は
#    Cf-Access-Jwt-Assertion を検証する。この aud が Worker の secret ACCESS_AUD になる。
resource "cloudflare_zero_trust_access_application" "worker" {
  account_id                = var.account_id
  name                      = var.name
  type                      = "self_hosted"
  allowed_idps              = var.allowed_idp_ids
  auto_redirect_to_identity = true
  session_duration          = var.session_duration

  destinations = [
    {
      type = "public"
      uri  = var.worker_host
    },
  ]

  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = true
      allow_any_on_loopback  = true
      # Portal（<portal>/servers-callback）とダッシュボードが MCP サーバーとして OAuth 接続するためのコールバック。
      # 無いと「Redirect URI not allowed by application configuration」になり、MCP サーバーが waiting のままになる。
      allowed_uris = concat(
        ["https://dash.cloudflare.com/${var.account_id}/one/access-controls/ai-controls/mcp-server/oauth-callback/*"],
        var.portal_hostname == null ? [] : ["https://${var.portal_hostname}/servers-callback"],
      )
    }
  }

  policies = local.policies
}

# 2. OIDC ディスカバリと JWKS は AWS IAM / STS が認証なしで取りに来るので Access を bypass する。
#    パス付きの destination はホスト全体のアプリより具体的なため、こちらが優先される。
resource "cloudflare_zero_trust_access_policy" "bypass_everyone" {
  account_id = var.account_id
  name       = "${var.name}-bypass-well-known"
  decision   = "bypass"

  include = [
    {
      everyone = {}
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "well_known_bypass" {
  account_id = var.account_id
  name       = "${var.name}-well-known"
  type       = "self_hosted"

  destinations = [
    {
      type = "public"
      uri  = "${var.worker_host}/.well-known/openid-configuration"
    },
    {
      type = "public"
      uri  = "${var.worker_host}/.well-known/jwks.json"
    },
  ]

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.bypass_everyone.id
      precedence = 1
    },
  ]
}

# 3. ポータルに登録する MCP サーバー。
resource "cloudflare_zero_trust_access_ai_controls_mcp_server" "this" {
  id                               = var.name
  account_id                       = var.account_id
  name                             = var.name
  hostname                         = local.mcp_url
  auth_type                        = "oauth"
  secure_web_gateway               = true
  is_shared_oauth_callback_enabled = false
}

# 4. ポータル経由のアクセスを許可する mcp 型アプリ。API / Terraform で MCP サーバーを作っても
#    自動では作られず、無いとポータルの同意画面に出ない。
resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id                = var.account_id
  name                      = "${var.name}-mcp"
  type                      = "mcp"
  allowed_idps              = var.allowed_idp_ids
  auto_redirect_to_identity = true
  session_duration          = var.session_duration

  destinations = [
    {
      type          = "via_mcp_server_portal"
      mcp_server_id = cloudflare_zero_trust_access_ai_controls_mcp_server.this.id
    },
  ]

  policies = local.policies

  lifecycle {
    # provider 5.27.0 は mcp 型にこれらを設定させない（validate で弾く）。API 側にはダッシュボードが付けた既定値が
    # 残っているので、未設定のままだと null に書き換える差分が出る。管理できない属性なので変更を無視する。
    ignore_changes = [cors_headers, enable_binding_cookie, options_preflight_bypass]
  }
}

# 5. ポータル（任意）。portal リソースは servers 一覧全体を所有するため、既存の portal と共存管理できない。
#    既存の portal を使う場合は create_portal = false のまま、出力 mcp_server_id を portal 側の servers に足す。
resource "cloudflare_zero_trust_access_application" "portal" {
  count = var.create_portal ? 1 : 0

  account_id                 = var.account_id
  name                       = "${var.name}-portal"
  type                       = "mcp_portal"
  domain                     = var.portal_hostname
  allowed_idps               = var.allowed_idp_ids
  auto_redirect_to_identity  = true
  session_duration           = var.portal_session_duration
  enable_binding_cookie      = false
  http_only_cookie_attribute = false
  options_preflight_bypass   = false
  cors_headers               = local.mcp_cors_headers

  destinations = [
    {
      type = "public"
      uri  = var.portal_hostname
    },
  ]

  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = true
      allow_any_on_loopback  = true
      allowed_uris           = var.portal_oauth_allowed_uris
    }
  }

  policies = local.policies
}

resource "cloudflare_zero_trust_access_ai_controls_mcp_portal" "this" {
  count = var.create_portal ? 1 : 0

  id         = var.name
  account_id = var.account_id
  name       = var.name
  hostname   = var.portal_hostname

  servers = [
    {
      server_id = cloudflare_zero_trust_access_ai_controls_mcp_server.this.id
      # 必ず true（利用者ごとの認証）。false だと Portal が管理者の資格を全員で共用して接続し、
      # 全員が管理者の身元で AWS のロールを引き受けてしまう（awsbridge は利用者本人の身元で権限を決める）。
      on_behalf = true
    },
  ]

  depends_on = [cloudflare_zero_trust_access_application.portal]
}
