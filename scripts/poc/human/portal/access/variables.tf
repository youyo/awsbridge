variable "account_id" {
  description = "Cloudflare アカウント ID（実値は terraform.tfvars に書く。gitignore 済み）"
  type        = string
}

variable "worker_host" {
  description = "PoC のポータル Worker のホスト名（スキーム・パスなし）。awsbridge-human-poc-portal.<subdomain>.workers.dev"
  type        = string

  validation {
    condition     = can(regex("^awsbridge-human-poc-portal\\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.worker_host))
    error_message = "worker_host は awsbridge-human-poc-portal.<subdomain>.workers.dev の形（スキーム・パスなし）。"
  }
}

variable "name" {
  description = "Access アプリ・ポリシーの名前の接頭辞。PoC のポータル用の名前だけ（片付けのガード）"
  type        = string
  default     = "awsbridge-human-poc-portal"

  validation {
    condition     = var.name == "awsbridge-human-poc-portal" || startswith(var.name, "awsbridge-human-poc-portal-")
    error_message = "name は awsbridge-human-poc-portal で始める（PoC 用の名前にだけ効かせる）。"
  }
}

variable "allowed_idp_ids" {
  description = "Access アプリで許可する IdP の ID 一覧（PoC では Google）。空なら制限しない"
  type        = list(string)
  default     = []
}

variable "teams" {
  description = <<-EOT
    チームごとの Access アプリ（<worker_host>/t/<チーム>）。emails はそのアプリに入れる利用者（Google には groups が無いので、
    所属の代わりに email の include を使う）。session_duration はそのアプリのセッション時間（N10 で短くして所属の取り直しを見る）。
  EOT
  type = map(object({
    emails           = list(string)
    session_duration = optional(string, "24h")
  }))

  validation {
    condition     = alltrue([for t in keys(var.teams) : can(regex("^[a-z0-9][a-z0-9-]{0,31}$", t))])
    error_message = "チーム名は小文字英数字とハイフン（32 文字まで）。"
  }
  validation {
    condition     = alltrue([for t in values(var.teams) : length(t.emails) > 0])
    error_message = "各チームに email を 1 つ以上（外すときは別の email、例 nobody@example.invalid に置き換える）。"
  }
}

variable "entry_session_duration" {
  description = "入口のアプリ（ホスト全体）のセッション時間"
  type        = string
  default     = "24h"
}

variable "path_cookie_attribute" {
  description = "Cookie Path（true ならアプリのパスごとに CF_Authorization を分ける）。N1 で切り替えの見え方を記録する"
  type        = bool
  default     = true
}

variable "enable_binding_cookie" {
  description = "Binding cookie（CF_Binding）。true にすると access-watch には CF_Binding も含めた Cookie を渡す"
  type        = bool
  default     = false
}
