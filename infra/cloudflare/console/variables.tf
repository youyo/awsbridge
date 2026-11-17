variable "account_id" {
  description = "Cloudflare アカウント ID"
  type        = string
}

variable "host" {
  description = "ポータルのホスト名（スキーム・パスなし。例 awsbridge-console.example.com。設定ファイルの portal.origin のホスト）。入口と、両階層のチームのアプリ（/t/<チーム>）を置く"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.host))
    error_message = "host はホスト名だけ（スキーム・パス・大文字なし）。"
  }
}

variable "name" {
  description = "Access アプリの名前の接頭辞"
  type        = string
  default     = "awsbridge-console"
}

variable "allowed_idp_ids" {
  description = "許可する IdP の ID 一覧"
  type        = list(string)
}

variable "teams" {
  description = <<-EOT
    チームごとの Access アプリ（<host>/t/<チーム>）。キーは設定ファイルのチーム名、tier は standard か admin、
    policy_ids はそのチームの利用者だけを許可する既存の reusable policy の ID（先頭ほど優先）。
  EOT
  type = map(object({
    tier       = optional(string, "standard")
    policy_ids = list(string)
  }))

  validation {
    condition     = alltrue([for k in keys(var.teams) : can(regex("^[a-z][a-z0-9-]{0,31}$", k))])
    error_message = "チーム名は小文字英数字とハイフン（先頭は英字、32 文字まで）。設定ファイルのチーム名と同じにする。"
  }
  validation {
    condition     = alltrue([for t in values(var.teams) : contains(["standard", "admin"], t.tier)])
    error_message = "tier は standard か admin。"
  }
  validation {
    condition     = alltrue([for t in values(var.teams) : length(t.policy_ids) > 0])
    error_message = "各チームに policy_ids を 1 つ以上（空だと誰も入れない／全員入れる設定の取り違えを避ける）。"
  }
}

variable "entry_policy_ids" {
  description = "入口のアプリ（ホスト全体）に付ける既存の reusable policy の ID（全チームの利用者をすべて含む範囲。先頭ほど優先）"
  type        = list(string)

  validation {
    condition     = length(var.entry_policy_ids) > 0
    error_message = "入口に policy_ids を 1 つ以上渡す。"
  }
}

variable "standard_session_duration" {
  description = "入口と Standard の階層のチームのアプリのセッション期間"
  type        = string
  default     = "24h"
}

variable "admin_session_duration" {
  description = "Admin の階層のチームのアプリのセッション期間。コンソールの Worker の ADMIN_ACCESS_MAX_AGE_SECONDS（既定 900 秒）に揃える"
  type        = string
  default     = "15m"
}
