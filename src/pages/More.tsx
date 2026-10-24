import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useBootstrap } from "../lib/data";
import { MORE_LINKS, PageHeader } from "../components/Layout";

export default function More() {
  const { data } = useBootstrap();
  const failed = data?.counts.failed ?? 0;
  return (
    <div>
      <PageHeader title="More" />
      <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
        {MORE_LINKS.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Link to={to} className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-2">
              <Icon size={20} className="text-ink-2" aria-hidden />
              <span className="flex-1">{label}</span>
              {to === "/inbox" && failed > 0 && <span className="rounded-full bg-warn px-2 text-[12px] font-semibold text-white num">{failed}</span>}
              <ChevronRight size={16} className="text-ink-3" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
