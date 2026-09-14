import { component$, Slot, type QRL } from "@builder.io/qwik";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-sky-400 text-slate-950 shadow-sm hover:bg-sky-300 focus-visible:outline-sky-400",
        secondary:
          "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-slate-400",
        ghost:
          "text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-slate-400",
      },
      size: {
        sm: "h-9 px-3",
        md: "h-11 px-4",
        lg: "h-12 px-5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = VariantProps<typeof buttonVariants> & {
  class?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick$?: QRL<() => void>;
};

export const Button = component$<ButtonProps>(
  ({
    variant,
    size,
    class: className,
    type = "button",
    disabled,
    onClick$,
  }) => (
    <button
      type={type}
      class={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled}
      onClick$={onClick$}
    >
      <Slot />
    </button>
  ),
);
