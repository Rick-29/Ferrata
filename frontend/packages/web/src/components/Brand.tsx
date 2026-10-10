import { ShieldCheck } from "lucide-react"
import { APP_ENDORSEMENT, APP_FULL_NAME, APP_NAME } from "@sqw/brand"

export default function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={compact ? "brand brand-compact" : "brand"}
      aria-label={APP_FULL_NAME}
    >
      <span className="brand-mark" aria-hidden="true">
        <ShieldCheck size={compact ? 17 : 20} strokeWidth={2.3} />
      </span>
      <span className="brand-name">{APP_NAME.toUpperCase()}</span>
      <span className="brand-by">{APP_ENDORSEMENT}</span>
    </div>
  )
}
