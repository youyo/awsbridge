variable "account_id" {
  description = "Cloudflare アカウント ID"
  type        = string
}

variable "worker_host" {
  description = "MCP クライアントの接続先のホスト名（/mcp。Access で守る。スキーム・パスなし）。基本は独自ドメインのホスト。例: awsbridge-mcp.example.com（試用なら awsbridge.example.workers.dev）"
  type        = string

  validation {
    condition     = !can(regex("[/:]", var.worker_host))
    error_message = "worker_host にはスキームやパスを含めず、ホスト名だけを指定する。"
  }
}

variable "issuer_host" {
  description = "OIDC issuer（IAM の OIDC プロバイダーの URL）のホスト名（スキーム・パスなし）。接続先のホストとは別のホストにする。例: awsbridge-oidc-mcp.example.com。未指定（null）なら worker_host と同じホストで /.well-known/* だけを bypass する"
  type        = string
  default     = null

  validation {
    condition     = var.issuer_host == null || !can(regex("[/:]", var.issuer_host))
    error_message = "issuer_host にはスキームやパスを含めず、ホスト名だけを指定する。"
  }
}

variable "name" {
  description = "リソース名の接頭辞"
  type        = string
  default     = "awsbridge"
}

variable "allowed_idp_ids" {
  description = "Access アプリで許可する IdP の ID 一覧（Zero Trust に登録済みのもの）"
  type        = list(string)
}

variable "access_policy_ids" {
  description = "アプリに適用する既存の reusable policy の ID 一覧（先頭ほど優先）。ログインを許可する利用者はこのポリシーで決める"
  type        = list(string)
}

variable "session_duration" {
  description = "Access アプリのセッション期間"
  type        = string
  default     = "24h"
}

variable "create_portal" {
  description = "true のとき MCP Portal も作る。既存の portal を使うなら false のまま、出力の mcp_server_id を portal 側へ足す"
  type        = bool
  default     = false
}

variable "portal_hostname" {
  description = "MCP Portal のホスト名（スキーム・パスなし）。create_portal = true のとき必須。既存の MCP Portal を使う場合も指定すると、Worker 用アプリがその MCP Portal からの OAuth 接続（servers-callback）を許可する"
  type        = string
  default     = null

  validation {
    condition     = var.portal_hostname == null || !can(regex("[/:]", var.portal_hostname))
    error_message = "portal_hostname にはスキームやパスを含めず、ホスト名だけを指定する。"
  }
}

variable "portal_oauth_allowed_uris" {
  description = "MCP Portal の動的クライアント登録（DCR）で許可するリダイレクト URI。例: Claude の https://claude.ai/api/mcp/auth_callback"
  type        = list(string)
  default     = []
}

variable "portal_session_duration" {
  description = "MCP Portal のセッション期間"
  type        = string
  default     = "24h"
}
