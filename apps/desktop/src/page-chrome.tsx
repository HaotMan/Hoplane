import { ArrowLeft } from "@phosphor-icons/react";

export function PageHeader({ eyebrow, title, breadcrumb, children }: { eyebrow?: string; title: string; breadcrumb?: React.ReactNode; children?: React.ReactNode }) {
  return <>
    {breadcrumb && <div className="page-breadcrumb-bar">{breadcrumb}</div>}
    <header className="page-header"><div><h1>{title}</h1>{eyebrow && <span className="sr-only">{eyebrow}</span>}</div>{children}</header>
  </>;
}

export function Breadcrumb({ parentLabel, current, onBack }: { parentLabel: string; current: string; onBack(): void }) {
  return <nav className="page-breadcrumb" aria-label="页面路径">
    <button type="button" className="breadcrumb-back" onClick={onBack} aria-label={`返回${parentLabel}`}><ArrowLeft size={16} aria-hidden="true" />{parentLabel}</button>
    <span aria-hidden="true">/</span>
    <em>{current}</em>
  </nav>;
}
