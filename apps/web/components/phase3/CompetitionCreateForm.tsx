"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { messages } from "@matchday/ui";
import {
  firstInvalidCompetitionCreateField,
  parseCompetitionCreateReceipt,
  parseCompetitionOrganisationBootstrapReceipt,
  parseCompetitionOrganisationOptions,
  phase3CompetitionCreateMachine,
  phase3CompetitionSports,
  phase3TimeZones,
  slugifyCompetitionName,
  type CompetitionCreateDraft,
  type CompetitionCreateField,
  type CompetitionOrganisationOption,
} from "@/lib/phase3-competition-create";
import { useCompetitionCreateDraft } from "@/lib/phase3-competition-draft.client";
import { phase3CountrySuggestions } from "@/lib/phase3-country-codes";
import styles from "./CompetitionCreateForm.module.css";

const initialDraft = (): CompetitionCreateDraft => ({
  organisation_id: "",
  name: "",
  slug: "",
  sport_code: "",
  venue: "",
  address: "",
  locality: "",
  country_code: phase3CompetitionCreateMachine.defaults.countryCode,
  starts_on: "",
  ends_on: "",
  timezone: phase3CompetitionCreateMachine.defaults.timezone,
  locale: phase3CompetitionCreateMachine.defaults.locale,
});

function upstreamMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

export function CompetitionCreateForm({ draftOwnerId }: { draftOwnerId: string }) {
  const router = useRouter();
  const { draft, setDraft, clearDraft } = useCompetitionCreateDraft(draftOwnerId, initialDraft);
  const [organisations, setOrganisations] = useState<CompetitionOrganisationOption[]>([]);
  const [organisationsLoading, setOrganisationsLoading] = useState(true);
  const [organisationsError, setOrganisationsError] = useState("");
  const [organisationLoadAttempt, setOrganisationLoadAttempt] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CompetitionCreateField, string>>>({});
  const [commandError, setCommandError] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const slugEditedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setOrganisationsLoading(true);
      setOrganisationsError("");
      try {
        const response = await fetch("/api/phase3/competitions", {
          cache: phase3CompetitionCreateMachine.noStore,
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        const options = response.ok ? parseCompetitionOrganisationOptions(payload) : null;
        if (!options) {
          setOrganisationsError(messages.organiserCreate.organisationsFailed);
          return;
        }
        setOrganisations(options);
        setDraft((current) => {
          const selectedStillExists = options.some((organisation) => organisation.id === current.organisation_id);
          const organisationId = selectedStillExists
            ? current.organisation_id
            : options.length === 1
              ? options[0]!.id
              : "";
          return organisationId === current.organisation_id ? current : { ...current, organisation_id: organisationId };
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setOrganisationsError(messages.organiserCreate.organisationsFailed);
        }
      } finally {
        if (!controller.signal.aborted) setOrganisationsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [organisationLoadAttempt, setDraft]);

  function update(field: CompetitionCreateField, value: string) {
    if (field === phase3CompetitionCreateMachine.fields.slug) slugEditedRef.current = true;
    const derivingSlug = field === phase3CompetitionCreateMachine.fields.name && !slugEditedRef.current;
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(derivingSlug ? { slug: slugifyCompetitionName(value) } : {}),
    }));
    setFieldErrors((current) => ({
      ...current,
      [field]: undefined,
      ...(derivingSlug ? { [phase3CompetitionCreateMachine.fields.slug]: undefined } : {}),
    }));
    setCommandError("");
    setAnnouncement("");
  }

  function focusField(field: CompetitionCreateField) {
    const element = formRef.current?.elements.namedItem(field);
    if (element instanceof HTMLElement) element.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || organisationsLoading || organisationsError) return;
    const bootstrapRequired = organisations.length === 0 && !draft.organisation_id;
    const invalidField = firstInvalidCompetitionCreateField(draft, {
      allowOrganisationBootstrap: bootstrapRequired,
    });
    if (invalidField) {
      setFieldErrors({ [invalidField]: messages.organiserCreate.invalidField });
      setCommandError(messages.organiserCreate.validationSummary);
      requestAnimationFrame(() => focusField(invalidField));
      return;
    }

    setBusy(true);
    setCommandError("");
    setAnnouncement(messages.organiserCreate.saving);
    try {
      let organisationId = draft.organisation_id;
      if (bootstrapRequired) {
        const bootstrapResponse = await fetch(phase3CompetitionCreateMachine.bootstrapRoute, {
          method: phase3CompetitionCreateMachine.post,
        });
        const bootstrapPayload: unknown = await bootstrapResponse.json().catch(() => null);
        const bootstrapReceipt = bootstrapResponse.ok
          ? parseCompetitionOrganisationBootstrapReceipt(bootstrapPayload)
          : null;
        if (!bootstrapReceipt) {
          setCommandError(upstreamMessage(bootstrapPayload, messages.organiserCreate.commandFailed));
          setAnnouncement("");
          requestAnimationFrame(() => errorRef.current?.focus());
          return;
        }
        organisationId = bootstrapReceipt.id;
        const option = {
          id: bootstrapReceipt.id,
          name: bootstrapReceipt.name,
          role: bootstrapReceipt.role,
        } satisfies CompetitionOrganisationOption;
        setOrganisations([option]);
        setDraft((current) => ({ ...current, organisation_id: organisationId }));
      }

      const response = await fetch("/api/phase3/competitions", {
        method: phase3CompetitionCreateMachine.post,
        headers: { "content-type": phase3CompetitionCreateMachine.applicationJson },
        body: JSON.stringify({
          ...draft,
          organisation_id: organisationId,
          [phase3CompetitionCreateMachine.idempotencyKey]: idempotencyKeyRef.current,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const receipt = response.ok ? parseCompetitionCreateReceipt(payload) : null;
      if (!receipt) {
        setCommandError(upstreamMessage(payload, messages.organiserCreate.commandFailed));
        setAnnouncement("");
        requestAnimationFrame(() => errorRef.current?.focus());
        return;
      }
      clearDraft();
      setAnnouncement(messages.organiserCreate.created);
      router.push(`/organiser/competitions/${encodeURIComponent(receipt.id)}/setup`);
    } catch {
      setCommandError(messages.organiserCreate.commandFailed);
      setAnnouncement("");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const field = (
    name: CompetitionCreateField,
    label: string,
    options: Readonly<{
      type?: "text" | "date";
      required?: boolean;
      autoComplete?: string;
      hint?: string;
      maxLength?: number;
    }> = {},
  ) => {
    const errorId = fieldErrors[name] ? `${name}-error` : undefined;
    const hintId = options.hint ? `${name}-hint` : undefined;
    return (
      <div className={name === phase3CompetitionCreateMachine.fields.address ? styles.wide : styles.field}>
        <label htmlFor={name}>{label}</label>
        <input
          id={name}
          name={name}
          value={draft[name]}
          type={options.type ?? "text"}
          required={options.required}
          autoComplete={options.autoComplete}
          maxLength={options.maxLength}
          aria-invalid={Boolean(errorId)}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          onChange={(event) => update(name, event.currentTarget.value)}
        />
        {options.hint ? (
          <p id={hintId} className={styles.hint}>
            {options.hint}
          </p>
        ) : null}
        {errorId ? (
          <p id={errorId} className={styles.error}>
            {fieldErrors[name]}
          </p>
        ) : null}
      </div>
    );
  };

  const showOrganisationSelector = organisationsLoading || organisations.length > 0 || Boolean(organisationsError);

  return (
    <form ref={formRef} className={styles.form} noValidate onSubmit={submit}>
      <p className={styles.intro}>{messages.organiserCreate.intro}</p>
      {commandError ? (
        <div ref={errorRef} className={styles.summary} role="alert" tabIndex={-1}>
          {commandError}
        </div>
      ) : null}
      <div className={styles.grid}>
        {showOrganisationSelector ? (
          <div className={styles.field}>
            <label htmlFor={phase3CompetitionCreateMachine.fields.organisationId}>
              {messages.organiserCreate.organisation}
            </label>
            <select
              id={phase3CompetitionCreateMachine.fields.organisationId}
              name={phase3CompetitionCreateMachine.fields.organisationId}
              value={draft.organisation_id}
              required={organisations.length > 0}
              disabled={organisationsLoading || organisations.length === 0}
              aria-invalid={Boolean(fieldErrors.organisation_id || organisationsError)}
              aria-describedby={
                fieldErrors.organisation_id || organisationsError
                  ? `${phase3CompetitionCreateMachine.fields.organisationId}-error`
                  : undefined
              }
              onChange={(event) =>
                update(phase3CompetitionCreateMachine.fields.organisationId, event.currentTarget.value)
              }
            >
              <option value="" disabled>
                {organisationsLoading
                  ? messages.organiserCreate.loadingOrganisations
                  : messages.organiserCreate.chooseOrganisation}
              </option>
              {organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name} ·{" "}
                  {organisation.role === "owner"
                    ? messages.organiserCreate.ownerRole
                    : messages.organiserCreate.organiserRole}
                </option>
              ))}
            </select>
            {fieldErrors.organisation_id || organisationsError ? (
              <p
                id={`${phase3CompetitionCreateMachine.fields.organisationId}-error`}
                className={styles.error}
                role={organisationsError ? "alert" : undefined}
              >
                {fieldErrors.organisation_id ?? organisationsError}
              </p>
            ) : null}
            {organisationsError ? (
              <button
                className={styles.retry}
                type="button"
                onClick={() => setOrganisationLoadAttempt((attempt) => attempt + 1)}
              >
                {messages.organiserCreate.retryOrganisations}
              </button>
            ) : null}
            <p className={styles.live} role="status">
              {organisationsLoading ? messages.organiserCreate.loadingOrganisations : ""}
            </p>
          </div>
        ) : null}
        {field(phase3CompetitionCreateMachine.fields.name, messages.organiserCreate.name, {
          required: true,
          maxLength: 160,
        })}
        {field(phase3CompetitionCreateMachine.fields.slug, messages.organiserCreate.slug, {
          required: true,
          maxLength: 120,
          hint: messages.organiserCreate.slugHint,
        })}
        <div className={styles.field}>
          <label htmlFor={phase3CompetitionCreateMachine.fields.sportCode}>{messages.organiserCreate.sport}</label>
          <select
            id={phase3CompetitionCreateMachine.fields.sportCode}
            name={phase3CompetitionCreateMachine.fields.sportCode}
            value={draft.sport_code}
            required
            aria-invalid={Boolean(fieldErrors.sport_code)}
            aria-describedby={
              fieldErrors.sport_code ? `${phase3CompetitionCreateMachine.fields.sportCode}-error` : undefined
            }
            onChange={(event) => update(phase3CompetitionCreateMachine.fields.sportCode, event.currentTarget.value)}
          >
            <option value="" disabled>
              {messages.organiserCreate.chooseSport}
            </option>
            {phase3CompetitionSports.map((sport) => (
              <option key={sport.code} value={sport.code}>
                {messages.organiserCreate.sports[sport.code]}
              </option>
            ))}
          </select>
          {fieldErrors.sport_code ? (
            <p id={`${phase3CompetitionCreateMachine.fields.sportCode}-error`} className={styles.error}>
              {fieldErrors.sport_code}
            </p>
          ) : null}
        </div>
        {field(phase3CompetitionCreateMachine.fields.venue, messages.organiserCreate.venue, {
          required: true,
          autoComplete: phase3CompetitionCreateMachine.autocomplete.venue,
        })}
        {field(phase3CompetitionCreateMachine.fields.address, messages.organiserCreate.address, {
          required: true,
          autoComplete: phase3CompetitionCreateMachine.autocomplete.address,
        })}
        {field(phase3CompetitionCreateMachine.fields.locality, messages.organiserCreate.locality, {
          autoComplete: phase3CompetitionCreateMachine.autocomplete.locality,
        })}
        <div className={styles.field}>
          <label htmlFor={phase3CompetitionCreateMachine.fields.countryCode}>{messages.organiserCreate.country}</label>
          <input
            id={phase3CompetitionCreateMachine.fields.countryCode}
            name={phase3CompetitionCreateMachine.fields.countryCode}
            list="country-code-suggestions"
            value={draft.country_code}
            type="text"
            required
            autoComplete={phase3CompetitionCreateMachine.autocomplete.country}
            maxLength={2}
            aria-invalid={Boolean(fieldErrors.country_code)}
            aria-describedby={["country-code-hint", fieldErrors.country_code ? "country_code-error" : undefined]
              .filter(Boolean)
              .join(" ")}
            onChange={(event) =>
              update(phase3CompetitionCreateMachine.fields.countryCode, event.currentTarget.value.toUpperCase())
            }
          />
          <datalist id="country-code-suggestions">
            {phase3CountrySuggestions.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </datalist>
          <p id="country-code-hint" className={styles.hint}>
            {messages.organiserCreate.countryHint}
          </p>
          {fieldErrors.country_code ? (
            <p id="country_code-error" className={styles.error}>
              {fieldErrors.country_code}
            </p>
          ) : null}
        </div>
        {field(phase3CompetitionCreateMachine.fields.startsOn, messages.organiserCreate.startsOn, {
          type: "date",
          required: true,
        })}
        {field(phase3CompetitionCreateMachine.fields.endsOn, messages.organiserCreate.endsOn, {
          type: "date",
          required: true,
        })}
        <div className={styles.field}>
          <label htmlFor={phase3CompetitionCreateMachine.fields.timezone}>{messages.organiserCreate.timezone}</label>
          <select
            id={phase3CompetitionCreateMachine.fields.timezone}
            name={phase3CompetitionCreateMachine.fields.timezone}
            value={draft.timezone}
            required
            aria-invalid={Boolean(fieldErrors.timezone)}
            aria-describedby={fieldErrors.timezone ? "timezone-error" : undefined}
            onChange={(event) => update(phase3CompetitionCreateMachine.fields.timezone, event.currentTarget.value)}
          >
            {phase3TimeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          {fieldErrors.timezone ? (
            <p id="timezone-error" className={styles.error}>
              {fieldErrors.timezone}
            </p>
          ) : null}
        </div>
        {field(phase3CompetitionCreateMachine.fields.locale, messages.organiserCreate.locale, {
          required: true,
        })}
      </div>
      <button
        className={styles.submit}
        type="submit"
        disabled={busy || organisationsLoading || Boolean(organisationsError)}
        data-busy={busy}
      >
        {busy ? messages.organiserCreate.saving : messages.organiserCreate.submit}
      </button>
      <p className={styles.live} aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </form>
  );
}
