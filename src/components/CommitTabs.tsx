import { useEffect, useRef } from 'react';
import { Codicon } from './Codicon';

interface CommitTab {
  id: string;
  label: string;
  icon: string;
  count: number;
  detail?: string;
}

export function CommitTabs({ tabs, activeTab, onSelect }: {
  tabs: CommitTab[];
  activeTab: string;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);
  return <div ref={ref} className="commit-tabs" role="tablist">
    {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-label={tab.label} aria-selected={activeTab === tab.id}
      title={tab.detail ? `${tab.label} (${tab.detail})` : `${tab.label} (${tab.count})`}
      className={activeTab === tab.id ? 'active' : ''} onClick={() => onSelect(tab.id)}>
      <Codicon name={tab.icon} />
      {activeTab === tab.id && <span>{tab.label}</span>}
      {tab.count > 0 && <b>{tab.count}</b>}
    </button>)}
  </div>;
}
