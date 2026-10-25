import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OctopusClientAccessProfile, OctopusProviderInterface } from "../../electron";
import { OcButton, OcDialog, OcDialogFooter, OcDialogHeader, OcMenuItem, OcMenuSurface } from "../../design-system/components";
import { useHomeProviderSwitch, type HomeHandoffMessage } from "../../shell/useHomeProviderSwitch";
import { providerDefaultModel } from "./chatWorkspaceCapabilities";
import "./providerModelPicker.css";

type Props = {
  accessProfile: OctopusClientAccessProfile;
  providers: OctopusProviderInterface[];
  handoffMessages: HomeHandoffMessage[];
  disabled: boolean;
};

export function providerName(provider: OctopusProviderInterface): string {
  const label = (provider.label || provider.id).replace(/[_-]+/g, " ").trim();
  return label ? label[0].toUpperCase() + label.slice(1) : provider.id;
}

export function HomeProviderSwitch({ accessProfile, providers, handoffMessages, disabled }: Props) {
  const home = useHomeProviderSwitch(accessProfile);
  const [menu, setMenu] = useState<{ right: number; bottom: number } | null>(null);
  const [target, setTarget] = useState<OctopusProviderInterface | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  const choices = providers.filter((provider) => providerDefaultModel(provider));
  const current = choices.find((provider) => provider.id === home.providerInterfaceId);
  if (!home.ready || !current || choices.length < 2) return null;
  const targetModel = target ? providerDefaultModel(target) : null;
  const openMenu = () => {
    const box = triggerRef.current?.getBoundingClientRect();
    if (box) setMenu({ right: window.innerWidth - box.right, bottom: window.innerHeight - box.top + 8 });
  };
  const confirm = async () => {
    if (!target || !targetModel) return;
    try {
      await home.switchProvider({
        providerInterfaceId: target.id,
        providerModel: targetModel.model,
        reasoningEffort: targetModel.supportedReasoningEfforts.length ? targetModel.defaultReasoningEffort : "",
        handoffMessages,
      });
      setTarget(null);
    } catch {}
  };
  return (
    <>
      <span className="provider-model-picker">
        <button
          aria-expanded={menu !== null}
          aria-haspopup="menu"
          aria-label={`Home provider: ${providerName(current)}`}
          className="provider-model-trigger"
          data-home-provider-switch
          disabled={disabled || home.pending}
          onClick={() => (menu ? setMenu(null) : openMenu())}
          ref={triggerRef}
          type="button"
        >
          <span className="provider-model-trigger-label"><span>{providerName(current)}</span></span>
          <span aria-hidden="true" className="provider-model-trigger-chevron" />
        </button>
      </span>
      {menu ? createPortal(
        <div className="fixed inset-0 z-50" onPointerDown={() => setMenu(null)}>
          <OcMenuSurface
            aria-label="Home provider"
            className="fixed min-w-[220px]"
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ right: menu.right, bottom: menu.bottom }}
          >
            {choices.map((provider) => (
              <OcMenuItem
                aria-checked={provider.id === current.id}
                description={provider.id === current.id ? undefined : providerDefaultModel(provider)?.displayName}
                key={provider.id}
                label={providerName(provider)}
                onClick={() => {
                  setMenu(null);
                  if (provider.id !== current.id) setTarget(provider);
                }}
                role="menuitemradio"
                selected={provider.id === current.id}
              />
            ))}
          </OcMenuSurface>
        </div>,
        document.body,
      ) : null}
      <OcDialog
        ariaLabelledBy="octopus-home-provider-title"
        busy={home.pending}
        initialFocusRef={cancelRef}
        onClose={() => { if (!home.pending) setTarget(null); }}
        open={target !== null}
        panelClassName="p-5"
        size="compact"
      >
        <OcDialogHeader className="p-0" title={`Switch Home to ${target ? providerName(target) : ""}?`} titleId="octopus-home-provider-title" />
        <p className="mt-2 text-base text-token-description-foreground">
          {handoffMessages.length
            ? "Home starts a new conversation that begins with the recent messages as context. The current conversation stays in history."
            : "Home starts a new conversation. The current conversation stays in history."}
        </p>
        {home.error ? <p className="mt-2 text-sm text-token-error-foreground">{home.error}</p> : null}
        <OcDialogFooter className="mt-5 min-h-0 border-0 p-0">
          <OcButton buttonRef={cancelRef} disabled={home.pending} onClick={() => setTarget(null)} variant="ghost">Cancel</OcButton>
          <OcButton disabled={home.pending || !targetModel} onClick={() => void confirm()} variant="primary">
            {home.pending ? "Switching…" : "Switch"}
          </OcButton>
        </OcDialogFooter>
      </OcDialog>
    </>
  );
}
