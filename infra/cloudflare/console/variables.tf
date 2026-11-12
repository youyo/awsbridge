variable "account_id" {
  description = "Cloudflare アカウント ID"
  type        = string
}

variable "standard_host" {
  description = "Standard の入口のホスト名（スキーム・パスなし。例 awsbridge-console.example.com。設定ファイルの portal.standardOrigin のホスト）"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.standard_host))
    error_message = "standard_host はホスト名だけ（スキーム・パス・大文字なし）。"
  }
}

variable "admin_host" {
  description = "Admin の入口のホスト名（例 awsbridge-admin-console.example.com。portal.adminOrigin のホスト）。Admin の階層のチームがあるときだけ指定する。Standard とは別のホストにする"
  type        = string
  default     = null

  validation {
    condition     = var.admin_host == null ? true : (can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.admin_host)) && var.admin_host != var.standard_host)
    error_message = "admin_host はホスト名だけで、standard_host と別のホストにする。"
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
  validation {
    condition     = var.admin_host != null || alltrue([for t in values(var.teams) : t.tier != "admin"])
    error_message = "Admin の階層のチームがあるときは admin_host を指定する。"
  }
}

variable "entry_policy_ids" {
  description = "入口のアプリ（ホスト全体）に付ける既存の reusable policy の ID。キーは standard / admin（その階層のチームの利用者をすべて含む範囲）"
  type        = map(list(string))

  validation {
    condition     = alltrue([for k in keys(var.entry_policy_ids) : contains(["standard", "admin"], k)])
    error_message = "entry_policy_ids のキーは standard か admin。"
  }
  validation {
    condition     = alltrue([for t in distinct(concat(["standard"], [for t in values(var.teams) : t.tier])) : length(lookup(var.entry_policy_ids, t, [])) > 0])
    error_message = "使う階層（standard と、Admin のチームがあれば admin）の入口に policy_ids を 1 つ以上渡す。"
  }
}

variable "standard_session_duration" {
  description = "Standard の階層のアプリ（入口とチーム）のセッション期間"
  type        = string
  default     = "24h"
}

variable "admin_session_duration" {
  description = "Admin の階層のアプリ（入口とチーム）のセッション期間。Admin の Worker の ACCESS_MAX_AGE_SECONDS（既定 900 秒）に揃える"
  type        = string
  default     = "15m"
}
