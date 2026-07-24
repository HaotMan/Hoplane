export function PageHeader({ eyebrow, title, breadcrumb, children }: { eyebrow?: string; title: string; breadcrumb?: React.ReactNode; children?: React.ReactNode }) {
  return <>
    {breadcrumb && <div className="page-breadcrumb-bar">{breadcrumb}</div>}
    <header className="page-header"><div>{!breadcrumb && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1></div>{children}</header>
  </>;
}

export function Breadcrumb({ parentLabel, current, onBack }: { parentLabel: string; current: string; onBack(): void }) {
  return <nav className="page-breadcrumb" aria-label="页面路径">
    <button type="button" className="breadcrumb-back" onClick={onBack} aria-label={`返回${parentLabel}`}><i aria-hidden="true" />{parentLabel}</button>
    <span aria-hidden="true">/</span>
    <em>{current}</em>
  </nav>;
}
