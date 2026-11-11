variable "account_id" {
  description = "Cloudflare アカウント ID（実値は terraform.tfvars に書く。gitignore 済み）"
  type        = string
}

variable "worker_host" {
  description = <<-EOT
    PoC のポータル Worker の入口のホスト名（スキーム・パスなし）。自社ドメインの Custom Domain の awsbridge-human-poc-portal.<ゾーン> か awsbridge-console-poc.<ゾーン>。
    workers.dev は Worker 側で無効にしたので不可。mise の access-plan / access-apply と destroy.sh が
    AWSBRIDGE_HUMAN_POC_PORTAL_HOST から -var で渡す（tfvars の値より優先）。
  EOT
  type        = string

  validation {
    condition     = can(regex("^(awsbridge-human-poc-portal|awsbridge-console-poc)\\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.worker_host)) && !endswith(var.worker_host, ".workers.dev")
    error_message = "worker_host は awsbridge-human-poc-portal.<ゾーン> か awsbridge-console-poc.<ゾーン> の形（スキーム・パスなし。workers.dev は不可）。"
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
