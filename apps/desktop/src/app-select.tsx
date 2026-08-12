import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";

export interface AppSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface AppSelectProps {
  options: AppSelectOption[];
  ariaLabel: string;
  value?: string;
  defaultValue?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  placeholder?: string;
  prefix?: ReactNode;
  onChange?(value: string): void;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

interface AppComboboxProps {
  options: string[];
  ariaLabel: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
}

function enabledIndex(options: AppSelectOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  for (let step = 0; step < options.length; step += 1) {
    const index = (start + direction * step + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function menuPosition(rect: DOMRect, optionCount: number, heightLimit: number): MenuPosition {
  const viewportPadding = 12;
  const gap = 6;
  const width = Math.min(Math.max(rect.width, 230), window.innerWidth - viewportPadding * 2);
  const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
  const desiredHeight = Math.min(heightLimit, optionCount * 36 + 10);
  const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
  const availableAbove = Math.max(0, rect.top - gap - viewportPadding);
  const comfortableHeight = Math.min(desiredHeight, 144);
  const placement = availableBelow >= comfortableHeight || availableBelow >= availableAbove ? "bottom" : "top";
  const maxHeight = placement === "bottom" ? availableBelow : availableAbove;
  const renderedHeight = Math.min(desiredHeight, maxHeight);
  return {
    top: placement === "bottom" ? rect.bottom + gap : rect.top - gap - renderedHeight,
    left,
    width,
    maxHeight,
    placement
  };
}

export function AppSelect({ options, ariaLabel, value, defaultValue = "", name, disabled = false, className = "", title, placeholder = "请选择", prefix, onChange }: AppSelectProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = `app-select-${useId().replaceAll(":", "")}`;
  const selectedValue = value ?? internalValue;
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  const selectedOption = options[selectedIndex];

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPosition(menuPosition(trigger.getBoundingClientRect(), options.length, 320));
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, updatePosition]);

  function openMenu(direction: 1 | -1 = 1) {
    if (disabled || options.every((option) => option.disabled)) return;
    const start = selectedIndex >= 0 ? selectedIndex : direction === 1 ? 0 : options.length - 1;
    setActiveIndex(enabledIndex(options, start, direction));
    setOpen(true);
  }

  function choose(nextValue: string) {
    const option = options.find((item) => item.value === nextValue);
    if (!option || option.disabled) return;
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(direction: 1 | -1) {
    const start = activeIndex < 0 ? direction === 1 ? 0 : options.length - 1 : activeIndex + direction;
    setActiveIndex(enabledIndex(options, start, direction));
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu(event.key === "ArrowUp" ? -1 : 1);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "Home" ? 1 : -1;
      setActiveIndex(enabledIndex(options, event.key === "Home" ? 0 : options.length - 1, direction));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeIndex >= 0) choose(options[activeIndex]!.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const menuStyle = position ? ({ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight } satisfies CSSProperties) : undefined;
  return <div className={`app-select ${open ? "open" : ""} ${disabled ? "disabled" : ""} ${className}`.trim()}>
    {name && <input type="hidden" name={name} value={selectedValue} disabled={disabled} />}
    <button
      ref={triggerRef}
      type="button"
      className="app-select-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      title={title}
      disabled={disabled}
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={onKeyDown}
    >
      {prefix && <span className="app-select-prefix" aria-hidden="true">{prefix}</span>}
      <span className={`app-select-value ${selectedOption ? "" : "placeholder"}`}>{selectedOption?.label ?? placeholder}</span>
      <CaretDown className="app-select-caret" size={14} weight="bold" aria-hidden="true" />
    </button>
    {open && position && createPortal(<div ref={menuRef} id={listboxId} className="app-select-menu" data-placement={position.placement} role="listbox" aria-label={ariaLabel} style={menuStyle}>
      {options.map((option, index) => <div
        key={`${option.value}-${index}`}
        id={`${listboxId}-option-${index}`}
        className={`app-select-option ${option.value === selectedValue ? "selected" : ""} ${index === activeIndex ? "active" : ""} ${option.disabled ? "disabled" : ""}`}
        role="option"
        aria-selected={option.value === selectedValue}
        aria-disabled={option.disabled || undefined}
        onPointerEnter={() => !option.disabled && setActiveIndex(index)}
        onPointerDown={(event) => { event.preventDefault(); choose(option.value); }}
      >
        <span>{option.label}</span>
        {option.value === selectedValue && <Check size={16} weight="bold" aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </div>;
}

export function AppCombobox({ options, ariaLabel, name, defaultValue = "", placeholder }: AppComboboxProps) {
  const [inputValue, setInputValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = `app-combobox-${useId().replaceAll(":", "")}`;
  const normalizedQuery = inputValue.trim().toLocaleLowerCase("zh-CN");
  const matches = options.filter((option) => !normalizedQuery || option.toLocaleLowerCase("zh-CN").includes(normalizedQuery));

  const updatePosition = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    setPosition(menuPosition(input.getBoundingClientRect(), matches.length, 260));
  }, [matches.length]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!inputRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  function openMenu() {
    if (matches.length === 0) return;
    const exactIndex = matches.findIndex((option) => option === inputValue);
    setActiveIndex(exactIndex >= 0 ? exactIndex : 0);
    setOpen(true);
  }

  function choose(option: string) {
    setInputValue(option);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      if (!open) openMenu();
      else setActiveIndex((current) => event.key === "ArrowDown" ? (current + 1) % matches.length : (current - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      choose(matches[activeIndex]!);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const menuStyle = position ? ({ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight } satisfies CSSProperties) : undefined;
  return <div className={`app-combobox ${open ? "open" : ""}`}>
    <input
      ref={inputRef}
      name={name}
      role="combobox"
      aria-label={ariaLabel}
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      autoComplete="off"
      value={inputValue}
      placeholder={placeholder}
      onFocus={openMenu}
      onClick={openMenu}
      onChange={(event) => {
        const nextValue = event.target.value;
        const nextQuery = nextValue.trim().toLocaleLowerCase("zh-CN");
        setInputValue(nextValue);
        setActiveIndex(0);
        setOpen(options.some((option) => !nextQuery || option.toLocaleLowerCase("zh-CN").includes(nextQuery)));
      }}
      onKeyDown={onKeyDown}
    />
    <CaretDown className="app-combobox-caret" size={14} weight="bold" aria-hidden="true" />
    {open && matches.length > 0 && position && createPortal(<div ref={menuRef} id={listboxId} className="app-select-menu" data-placement={position.placement} role="listbox" aria-label={`${ariaLabel}建议`} style={menuStyle}>
      {matches.map((option, index) => <div
        key={option}
        id={`${listboxId}-option-${index}`}
        className={`app-select-option ${option === inputValue ? "selected" : ""} ${index === activeIndex ? "active" : ""}`}
        role="option"
        aria-selected={option === inputValue}
        onPointerEnter={() => setActiveIndex(index)}
        onPointerDown={(event) => { event.preventDefault(); choose(option); }}
      >
        <span>{option}</span>
        {option === inputValue && <Check size={16} weight="bold" aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </div>;
}
