'use client';

import type { ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional leading count/figure, rendered in mono. */
  count?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  variant?: 'underline' | 'segmented';
  className?: string;
}

/** Direction A tabs — underline (page-level) or segmented (in-panel). */
export function Tabs({ items, active, onSelect, variant = 'underline', className }: TabsProps) {
  const base = variant === 'segmented' ? 'gc-tabs gc-tabs--segmented' : 'gc-tabs';
  return (
    <div className={`${base} ${className ?? ''}`} role="tablist">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`gc-tab${isActive ? ' is-active' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            {item.count != null && <span className="n">{item.count}</span>}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
