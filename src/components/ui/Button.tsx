"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant =
  | "primary" | "secondary" | "ghost" | "danger" | "dangerSoft" | "dark";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
  dangerSoft: "btn-danger-soft",
  dark: "btn-dark",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
  xl: "btn-xl",
};

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the full width of the parent. */
  block?: boolean;
  /** Shows a spinner and blocks clicks. Use for anything that hits the network. */
  loading?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
  className?: string;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "secondary",
    size = "md",
    block,
    loading,
    icon,
    iconRight,
    children,
    className = "",
    disabled,
    type = "button",
    ...rest
  },
  ref
) {
  const iconSize = size === "sm" ? 14 : size === "xl" ? 20 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={[
        "btn",
        VARIANT[variant],
        SIZE[size],
        block ? "btn-block" : "",
        children == null ? "btn-icon" : "",
        className,
      ].filter(Boolean).join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="spinner" style={{ width: iconSize, height: iconSize }} aria-hidden />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
});

/** Icon-only button. The label is required — it becomes the accessible name. */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  ...rest
}: Omit<Props, "children" | "icon"> & { icon: IconName; label: string }) {
  return (
    <Button variant={variant} size={size} aria-label={label} title={label} icon={icon} {...rest} />
  );
}

/** Button-styled anchor, for links that should read as actions. */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  block,
  icon,
  iconRight,
  children,
  className = "",
  external,
  ...rest
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
  className?: string;
  external?: boolean;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href">) {
  const iconSize = size === "sm" ? 14 : size === "xl" ? 20 : 16;
  return (
    <a
      href={href}
      className={[
        "btn", VARIANT[variant], SIZE[size], block ? "btn-block" : "", className,
      ].filter(Boolean).join(" ")}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...rest}
    >
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
      {external ? <Icon name="external" size={iconSize - 2} /> : null}
    </a>
  );
}

export default Button;
