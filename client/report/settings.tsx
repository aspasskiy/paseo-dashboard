import { ActivityIndicator, Text, View } from "react-native";
import type { ProviderOption, ReportSettings } from "../../shared/report";
import { usePalette } from "../kit";
import { Chip, IconButton } from "./parts";

type Stage = "notes" | "synthesis";

const COPY: Record<Stage, { title: string; hint: string; auto: string }> = {
  notes: { title: "Notes", hint: "Many short calls, one per batch of sessions. A fast model is plenty.", auto: "fast" },
  synthesis: { title: "Report", hint: "One call over all notes. Worth the strongest model.", auto: "strongest" },
};

/** Two pickers: which provider and model writes the notes, and which writes the report. */
export function SettingsPanel({
  providers,
  loading,
  settings,
  resolved,
  onChange,
  onClose,
}: {
  providers: ProviderOption[];
  loading: boolean;
  settings: ReportSettings;
  resolved: { notes: string; synthesis: string };
  onChange: (next: ReportSettings) => void;
  onClose: () => void;
}) {
  const p = usePalette();
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: p.line, backgroundColor: p.card, padding: 14, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: p.fg, fontSize: 14, fontWeight: "500", flex: 1 }}>Who writes the report</Text>
        <IconButton icon="X" label="Close" onPress={onClose} />
      </View>
      {loading ? <ActivityIndicator color={p.muted} /> : null}
      {!loading && !providers.length ? (
        <Text style={{ color: p.muted, fontSize: 12 }}>Reports need Claude ready in Paseo. Set it up in Paseo's settings first.</Text>
      ) : null}
      {providers.length
        ? (["notes", "synthesis"] as Stage[]).map((stage, i) => (
            <View key={stage} style={{ gap: 8 }}>
              {i > 0 ? <View style={{ height: 1, backgroundColor: p.border, marginHorizontal: -14, marginBottom: 6 }} /> : null}
              <Picker
                stage={stage}
                providers={providers}
                value={settings[stage]}
                resolved={resolved[stage]}
                onChange={(choice) => onChange({ ...settings, [stage]: choice })}
              />
            </View>
          ))
        : null}
      <Text style={{ color: p.muted, fontSize: 12, lineHeight: 16 }}>
        Both run as Paseo helper agents on your own provider, started with no tools: they only read the text they are given. Only providers that enforce this are listed (Claude for now). Notes are cached per session, so a new notes model only affects sessions it has not read.
      </Text>
    </View>
  );
}

function Picker({
  stage,
  providers,
  value,
  resolved,
  onChange,
}: {
  stage: Stage;
  providers: ProviderOption[];
  value: ReportSettings["notes"];
  resolved: string;
  onChange: (next: ReportSettings["notes"]) => void;
}) {
  const p = usePalette();
  const copy = COPY[stage];
  const provider = (value.provider && providers.find((x) => x.id === value.provider)) || providers[0];
  const modelPart = resolved.split(" · ").slice(1).join(" · ");
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: p.fg, fontSize: 13, fontWeight: "500" }}>{copy.title}</Text>
        <Text style={{ color: p.muted, fontSize: 12, flex: 1 }} numberOfLines={1}>
          {resolved}
        </Text>
      </View>
      <Text style={{ color: p.muted, fontSize: 12, lineHeight: 16 }}>{copy.hint}</Text>
      {providers.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {providers.map((x) => (
            <Chip key={x.id} label={x.label} active={provider?.id === x.id} onPress={() => onChange({ provider: x.id, model: null })} />
          ))}
        </View>
      ) : null}
      {provider && provider.models.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Chip
            label={!value.model && modelPart ? "Auto" + " · " + modelPart : "Auto (" + copy.auto + ")"}
            active={!value.model}
            onPress={() => onChange({ provider: value.provider, model: null })}
          />
          {provider.models.map((m) => (
            <Chip key={m.id} label={m.label} active={value.model === m.id} onPress={() => onChange({ provider: provider.id, model: m.id })} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
