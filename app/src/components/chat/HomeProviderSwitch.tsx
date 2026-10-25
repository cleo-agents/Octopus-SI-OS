import { useRef, useState } from "react";
import type { OctopusClientAccessProfile, OctopusProviderInterface } from "../../electron";
import { OcButton, OcDialog, OcDialogFooter, OcDialogHeader, OcMenuItem, OcMenuSurface, OcPopover } from "../../design-system/components";
import { useHomeProviderSwitch } from "../../shell/useHomeProviderSwitch";
import { providerDefaultModel } from "./chatWorkspaceCapabilities";
import "./providerModelPicker.css";

type Props = {
  accessProfile: OctopusClientAccessProfile;
  providers: OctopusProviderInterface[];
  disabled: boolean;
};

export function providerName(provider: OctopusProviderInterface): string {
  const label = (provider.label || provider.id).replace(/[_-]+/g, " ").trim();
  return label ? label[0].toUpperCase() + label.slice(1) : provider.id;
}

export function HomeProviderSwitch({ accessProfile, providers, disabled }: Props) {
  const home = useHomeProviderSwitch(accessProfile);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<OctopusProviderInterface | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const choices = providers.filter((provider) => providerDefaultModel(provider));
  const current = choices.find((provider) => provider.id === home.providerInterfaceId);
  if (!home.ready || !current || choices.length < 2) return null;
  const targetModel = target ? providerDefaultModel(target) : null;
  const confirm = async () => {
    if (!target || !targetModel) return;
    try {
      await home.switchProvider({
        providerInterfaceId: target.id,
        providerModel: targetModel.model,
        reasoningEffort: targetModel.supportedReasoningEfforts.length ? targetModel.defaultReasoningEffort : "",
      });
      setTarget(null);
    } catch {}
  };
  return (
    <>
      <OcPopover
        align="end"
        anchor={(
          <span className="provider-model-picker">
            <button
              aria-expanded={open}
              aria-haspopup="menu"
              aria-label={`Home provider: ${providerName(current)}`}
              className="provider-model-trigger"
              data-home-provider-switch
              disabled={disabled || home.pending}
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              <span className="provider-model-trigger-label"><span>{providerName(current)}</span></span>
              <span aria-hidden="true" className="provider-model-trigger-chevron" />
            </button>
          </span>
        )}
        label="Home provider"
        onDismiss={() => setOpen(false)}
        open={open}
        placement="top"
        role="menu"
      >
        <OcMenuSurface>
          {choices.map((provider) => (
            <OcMenuItem
              description={providerDefaultModel(provider)?.displayName}
              key={provider.id}
              label={providerName(provider)}
              onClick={() => {
                setOpen(false);
                if (provider.id !== current.id) setTarget(provider);
              }}
              role="menuitemradio"
              aria-checked={provider.id === current.id}
              selected={provider.id === current.id}
            />
          ))}
        </OcMenuSurface>
      </OcPopover>
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
          Home starts a new conversation. The current conversation stays in history.
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
