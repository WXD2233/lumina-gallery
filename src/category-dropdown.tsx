import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Folder, LayoutGrid } from 'lucide-react';
import './category-dropdown.css';

type CategoryDropdownProps = {
  label: string;
  count: number;
  total: number;
  selected: string;
  categories: { name: string; count: number }[];
  onSelect: (category: string) => void;
};

export function CategoryDropdown({ label, count, total, selected, categories, onSelect }: CategoryDropdownProps) {
  const [open, setOpen] = useState(false);
  const [availableHeight, setAvailableHeight] = useState(360);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelId = useId();
  const cancelClose = () => { clearTimeout(closeTimer.current); };
  const show = () => { cancelClose(); setOpen(true); };
  const dismiss = () => { cancelClose(); setOpen(false); };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setAvailableHeight(Math.max(120, window.innerHeight - (trigger.current?.getBoundingClientRect().bottom ?? 0) - 24));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return <div className="gallery-category-picker" ref={container}
    onPointerEnter={event => { if (event.pointerType === 'mouse') show(); }}
    onPointerLeave={event => {
      if (event.pointerType !== 'mouse') return;
      cancelClose();
      closeTimer.current = setTimeout(() => {
        if (!panel.current?.contains(document.activeElement)) setOpen(false);
      }, 160);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) dismiss(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(); trigger.current?.focus(); }
      if (event.key === 'ArrowDown' && event.target === trigger.current) {
        event.preventDefault(); show();
        requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button[aria-current="true"], button')?.focus());
      }
    }}>
    <button ref={trigger} type="button" className="selected gallery-category-trigger" aria-expanded={open} aria-controls={panelId} onClick={show} title="展开图集分类">
      {label}<span>{count}</span><ChevronDown size={16} className={open ? 'is-open' : ''}/>
    </button>
    {open && <nav id={panelId} ref={panel} className="gallery-category-popover" aria-label="快捷分类">
      <div className="gallery-category-menu" style={{ maxHeight: Math.min(360, availableHeight) }}>
        <p>选择分类</p>
        {[{ name: '', count: total }, ...categories].map(item => <button key={item.name} type="button"
          className={`gallery-category-option ${selected === item.name ? 'is-current' : ''}`}
          aria-current={selected === item.name ? 'true' : undefined}
          onClick={() => { dismiss(); trigger.current?.focus(); onSelect(item.name); }}>
          {item.name ? <Folder size={17}/> : <LayoutGrid size={17}/>}
          <strong>{item.name || '全部图集'}</strong><small>{item.count}</small>
          {selected === item.name && <Check size={16}/>}
        </button>)}
      </div>
    </nav>}
  </div>;
}
