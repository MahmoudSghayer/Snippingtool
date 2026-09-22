import { cn } from '../lib/cn.js';

import type { ReactNode } from 'react';

export interface SidebarNavItem {
  key: string;
  label: string;
  href: string;
  icon?: ReactNode;
  active?: boolean;
  badge?: ReactNode;
}

export interface SidebarSection {
  title?: string;
  items: SidebarNavItem[];
}

export interface SidebarProps {
  brand: ReactNode;
  sections: SidebarSection[];
  footer?: ReactNode;
  /** Rendered instead of an <a> for router-aware navigation — pass your
   * router's Link and this component supplies href/className/children. */
  linkComponent?: (props: {
    href: string;
    className: string;
    children: ReactNode;
    'aria-current'?: 'page';
  }) => ReactNode;
  className?: string;
}

export function Sidebar({ brand, sections, footer, linkComponent, className }: SidebarProps) {
  const Link =
    linkComponent ??
    (({ href, className: c, children, ...rest }) => (
      <a href={href} className={c} {...rest}>
        {children}
      </a>
    ));

  return (
    <aside
      className={cn(
        'flex h-full w-64 shrink-0 flex-col border-r border-[--sl-border] bg-[--sl-surface]',
        className,
      )}
    >
      <div className="flex h-16 items-center gap-2 border-b border-[--sl-border] px-5">{brand}</div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {sections.map((section, i) => (
          <div key={section.title ?? i} className={i > 0 ? 'mt-5' : undefined}>
            {section.title && (
              <p className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-[--sl-fg-muted]">
                {section.title}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={item.active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-[--sl-radius-sm] px-2.5 py-2 text-sm font-medium transition-colors',
                      item.active
                        ? 'bg-[--sl-accent]/15 text-[--sl-accent]'
                        : 'text-[--sl-fg-muted] hover:bg-[--sl-card-2] hover:text-[--sl-fg]',
                    )}
                  >
                    {item.icon}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {footer && <div className="border-t border-[--sl-border] p-3">{footer}</div>}
    </aside>
  );
}
