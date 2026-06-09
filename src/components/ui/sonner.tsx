import { Toaster as Sonner, type ToasterProps } from "sonner";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { useTheme } from "@/lib/theme";

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      closeButton
      gap={12}
      offset={20}
      visibleToasts={4}
      icons={{
        success: <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-[var(--toast-success-icon)]" strokeWidth={2.25} />,
        error: <AlertCircle className="h-[18px] w-[18px] shrink-0 text-[var(--toast-error-icon)]" strokeWidth={2.25} />,
        warning: <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-[var(--toast-warning-icon)]" strokeWidth={2.25} />,
        info: <Info className="h-[18px] w-[18px] shrink-0 text-[var(--toast-info-icon)]" strokeWidth={2.25} />,
      }}
      toastOptions={{
        classNames: {
          toast: "alyson-toast",
          title: "alyson-toast-title",
          description: "alyson-toast-description",
          success: "alyson-toast-success",
          error: "alyson-toast-error",
          warning: "alyson-toast-warning",
          info: "alyson-toast-info",
          actionButton: "alyson-toast-action",
          cancelButton: "alyson-toast-cancel",
          closeButton: "alyson-toast-close",
        },
      }}
      {...props}
    />
  );
}
