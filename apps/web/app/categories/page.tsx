'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  CategoriesResponse,
  CategorySuggestion,
  CoreStructureType,
  MetricFieldDefinition,
  MetricFieldSuggestion,
  MetricFieldType,
} from '@journal/contract';
import {
  ApiRequestError,
  approveCategory,
  approveMetricFieldSuggestion,
  approveMetricFieldValue,
  approveSuggestion,
  defineMetricField,
  listCategories,
  listMetricFields,
  listMetricFieldSuggestions,
  listMetricFieldValues,
  listMetricFieldValueSuggestions,
  listSuggestions,
  parkMetricFieldSuggestion,
  parkSuggestion,
  rejectMetricFieldSuggestion,
  rejectSuggestion,
  updateMetricField,
} from '@/lib/api';
import styles from './page.module.css';

const STRUCTURE_TYPES: { value: CoreStructureType; label: string }[] = [
  { value: 'metric', label: 'Metric' },
  { value: 'review_medium', label: 'Review medium' },
  { value: 'list_type', label: 'List type' },
  { value: 'opinion_subject', label: 'Opinion subject' },
];

const STRUCTURE_LABEL: Record<CoreStructureType, string> = {
  metric: 'Metric',
  review_medium: 'Review medium',
  list_type: 'List type',
  opinion_subject: 'Opinion subject',
};

const FIELD_TYPES: { value: MetricFieldType; label: string }[] = [
  { value: 'numeric', label: 'Numeric' },
  { value: 'enum', label: 'Category' },
  { value: 'text', label: 'Text' },
  { value: 'score', label: 'Score' },
];

function fieldTypeLabel(fieldType: MetricFieldType): string {
  return FIELD_TYPES.find((t) => t.value === fieldType)?.label ?? fieldType;
}

interface EnumFieldState {
  values: string[];
  suggestions: CategorySuggestion[];
}

/**
 * The approved category set the AI is allowed to extract against, and its
 * one growth mechanism: the AI suggesting a new one for approval, or a
 * direct request (`plan.md` M8, `requirements.md` §5.3 — "the AI does not
 * autonomously create new metrics"). Every suggestion names the entry that
 * prompted it, so the reasoning can be checked against the actual prose
 * before deciding.
 *
 * "Metric fields" (`plan.md` M9) extends the same approval philosophy one
 * level: a metric's structured fields, and an enum field's approved values,
 * grow the same two ways as a category name does.
 */
export default function CategoriesPage() {
  const [categories, setCategories] = useState<CategoriesResponse | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [fields, setFields] = useState<MetricFieldDefinition[] | null>(null);
  const [fieldSuggestions, setFieldSuggestions] = useState<MetricFieldSuggestion[] | null>(null);
  const [enumFieldState, setEnumFieldState] = useState<Record<string, EnumFieldState>>({});
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const [requestType, setRequestType] = useState<CoreStructureType>('metric');
  const [requestName, setRequestName] = useState('');
  const [requesting, setRequesting] = useState(false);

  const [newFieldMetric, setNewFieldMetric] = useState('');
  const [newFieldKey, setNewFieldKey] = useState('');
  const [newFieldLabel, setNewFieldLabel] = useState('');
  const [newFieldType, setNewFieldType] = useState<MetricFieldType>('numeric');
  const [newFieldUnit, setNewFieldUnit] = useState('');
  const [newFieldDescription, setNewFieldDescription] = useState('');
  const [definingField, setDefiningField] = useState(false);

  const [newValueByField, setNewValueByField] = useState<Record<string, string>>({});
  const [addingValueForField, setAddingValueForField] = useState<string | null>(null);

  // Editing a field already defined (`PATCH /metrics/fields/:id`) — label,
  // description, unit, and score bounds only; `metric`/`fieldKey`/`fieldType`
  // are a field's identity and shape, not something this form touches.
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [editScoreMin, setEditScoreMin] = useState('');
  const [editScoreMax, setEditScoreMax] = useState('');
  const [savingFieldEdit, setSavingFieldEdit] = useState(false);

  const load = () => {
    Promise.all([
      listCategories(),
      listSuggestions({ status: 'pending' }),
      listSuggestions({ status: 'parked' }),
      listMetricFields(),
      listMetricFieldSuggestions({ status: 'pending' }),
      listMetricFieldSuggestions({ status: 'parked' }),
    ])
      .then(([categoriesResponse, pendingResponse, parkedResponse, fieldsResponse, pendingFieldsResponse, parkedFieldsResponse]) => {
        setCategories(categoriesResponse);
        // Pending and parked share one list — a suggestion set aside "to be
        // thought about" is still fully actionable here, just no longer
        // nagging (`requirements.md` §12: no reminders, ever); only the
        // section it renders under differs.
        setSuggestions([...pendingResponse.suggestions, ...parkedResponse.suggestions]);
        setFields(fieldsResponse.fields);
        setFieldSuggestions([...pendingFieldsResponse.suggestions, ...parkedFieldsResponse.suggestions]);

        const enumFields = fieldsResponse.fields.filter((f) => f.fieldType === 'enum');
        Promise.all(
          enumFields.map((f) =>
            Promise.all([listMetricFieldValues(f.id), listMetricFieldValueSuggestions(f.id, 'pending')]).then(
              ([valuesResponse, valueSuggestionsResponse]) =>
                [f.id, { values: valuesResponse.values, suggestions: valueSuggestionsResponse.suggestions }] as const,
            ),
          ),
        ).then((entries) => setEnumFieldState(Object.fromEntries(entries)));
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load categories.'));
  };

  useEffect(load, []);

  const decide = (id: string, decision: 'approve' | 'reject' | 'park') => {
    setDecidingId(id);
    (decision === 'approve' ? approveSuggestion(id) : decision === 'reject' ? rejectSuggestion(id) : parkSuggestion(id))
      .then(() => {
        setSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        if (decision === 'approve') load(); // the newly-approved name now belongs in the approved list too
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setDecidingId(null));
  };

  const decideField = (id: string, decision: 'approve' | 'reject' | 'park') => {
    setDecidingId(id);
    (decision === 'approve'
      ? approveMetricFieldSuggestion(id)
      : decision === 'reject'
        ? rejectMetricFieldSuggestion(id)
        : parkMetricFieldSuggestion(id)
    )
      .then(() => {
        setFieldSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        if (decision === 'approve') load(); // the newly-approved field now belongs in the definitions list too
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setDecidingId(null));
  };

  const decideValue = (fieldId: string, id: string, decision: 'approve' | 'reject') => {
    setDecidingId(id);
    (decision === 'approve' ? approveSuggestion(id) : rejectSuggestion(id))
      .then(() => {
        setEnumFieldState((current) => {
          const state = current[fieldId];
          if (!state) return current;
          return { ...current, [fieldId]: { ...state, suggestions: state.suggestions.filter((s) => s.id !== id) } };
        });
        if (decision === 'approve') load(); // the newly-approved value now belongs in the values list too
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setDecidingId(null));
  };

  const requestCategory = () => {
    const name = requestName.trim();
    if (!name) return;
    setRequesting(true);
    approveCategory(requestType, name)
      .then(() => {
        setRequestName('');
        load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not add category.'))
      .finally(() => setRequesting(false));
  };

  const requestField = () => {
    const metric = newFieldMetric || categories?.metric[0] || '';
    const fieldKey = newFieldKey.trim();
    const label = newFieldLabel.trim();
    const description = newFieldDescription.trim();
    if (!metric || !fieldKey || !label || !description) return;
    setDefiningField(true);
    defineMetricField({
      metric,
      fieldKey,
      label,
      fieldType: newFieldType,
      description,
      ...(newFieldType === 'numeric' && newFieldUnit.trim() ? { unit: newFieldUnit.trim() } : {}),
    })
      .then(() => {
        setNewFieldKey('');
        setNewFieldLabel('');
        setNewFieldUnit('');
        setNewFieldDescription('');
        load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not add field.'))
      .finally(() => setDefiningField(false));
  };

  const startFieldEdit = (field: MetricFieldDefinition) => {
    setEditingFieldId(field.id);
    setEditLabel(field.label);
    setEditDescription(field.description);
    setEditUnit(field.unit ?? '');
    setEditScoreMin(field.scoreMin === null ? '' : String(field.scoreMin));
    setEditScoreMax(field.scoreMax === null ? '' : String(field.scoreMax));
  };

  const saveFieldEdit = (field: MetricFieldDefinition) => {
    const label = editLabel.trim();
    const description = editDescription.trim();
    if (!label || !description) return;
    setSavingFieldEdit(true);
    updateMetricField(field.id, {
      label,
      description,
      ...(field.fieldType === 'numeric' ? { unit: editUnit.trim() || null } : {}),
      ...(field.fieldType === 'score'
        ? { scoreMin: editScoreMin.trim() ? Number(editScoreMin) : null, scoreMax: editScoreMax.trim() ? Number(editScoreMax) : null }
        : {}),
    })
      .then(() => {
        setEditingFieldId(null);
        load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save field.'))
      .finally(() => setSavingFieldEdit(false));
  };

  const requestValue = (fieldId: string) => {
    const value = (newValueByField[fieldId] ?? '').trim();
    if (!value) return;
    setAddingValueForField(fieldId);
    approveMetricFieldValue(fieldId, value)
      .then(() => {
        setNewValueByField((current) => ({ ...current, [fieldId]: '' }));
        load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not add value.'))
      .finally(() => setAddingValueForField(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (categories === null || suggestions === null || fields === null || fieldSuggestions === null) {
    return <p className={styles.hint}>Loading…</p>;
  }

  // Parked (`plan.md` M18): set aside to reconsider later, not resurfaced on
  // its own (`requirements.md` §12) — a plain, unbadged section rather than
  // a queue that nags.
  const pendingSuggestions = suggestions.filter((s) => s.status === 'pending');
  const parkedSuggestions = suggestions.filter((s) => s.status === 'parked');
  const pendingFieldSuggestions = fieldSuggestions.filter((s) => s.status === 'pending');
  const parkedFieldSuggestions = fieldSuggestions.filter((s) => s.status === 'parked');

  return (
    <div>
      <Link href="/publish-queue" className={styles.seeAll}>
        Public-by-default settings and the publish queue →
      </Link>

      <section className={styles.section}>
        <h2 className={styles.heading}>Approved</h2>
        {STRUCTURE_TYPES.map(({ value, label }) => (
          <div key={value} className={styles.approvedGroup}>
            <p className={styles.heading}>{label}</p>
            {categories[value].length === 0 ? (
              <p className={styles.empty}>None yet.</p>
            ) : (
              <ul className={styles.approvedList}>
                {categories[value].map((name) => (
                  <li key={name} className={styles.pill}>
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        <div className={styles.requestForm}>
          <select
            className={styles.select}
            value={requestType}
            onChange={(event) => setRequestType(event.target.value as CoreStructureType)}
            aria-label="Category kind"
          >
            {STRUCTURE_TYPES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            type="text"
            placeholder="Add a category directly"
            value={requestName}
            onChange={(event) => setRequestName(event.target.value)}
            aria-label="New category name"
          />
          <button type="button" className={styles.addButton} onClick={requestCategory} disabled={requesting || !requestName.trim()}>
            Add
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Suggested by the AI</h2>
        {pendingSuggestions.length === 0 ? (
          <p className={styles.empty}>Nothing pending.</p>
        ) : (
          <ul className={styles.suggestionList}>
            {pendingSuggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionMeta}>
                    {STRUCTURE_LABEL[suggestion.structureType as CoreStructureType] ?? suggestion.structureType}
                  </span>
                  <span className={styles.suggestionName}>{suggestion.name}</span>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decide(suggestion.id, 'approve')}
                    disabled={decidingId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.parkButton}
                    onClick={() => decide(suggestion.id, 'park')}
                    disabled={decidingId === suggestion.id}
                  >
                    Park
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decide(suggestion.id, 'reject')}
                    disabled={decidingId === suggestion.id}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {parkedSuggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Parked</h2>
          <ul className={styles.suggestionList}>
            {parkedSuggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionMeta}>
                    {STRUCTURE_LABEL[suggestion.structureType as CoreStructureType] ?? suggestion.structureType}
                  </span>
                  <span className={styles.suggestionName}>{suggestion.name}</span>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decide(suggestion.id, 'approve')}
                    disabled={decidingId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decide(suggestion.id, 'reject')}
                    disabled={decidingId === suggestion.id}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.heading}>Metric fields</h2>
        {categories.metric.length === 0 ? (
          <p className={styles.empty}>No approved metrics yet.</p>
        ) : (
          categories.metric.map((metric) => {
            const metricFields = fields.filter((f) => f.metric === metric);
            return (
              <div key={metric} className={styles.approvedGroup}>
                <p className={styles.heading}>{metric}</p>
                {metricFields.length === 0 ? (
                  <p className={styles.empty}>No fields defined.</p>
                ) : (
                  <ul className={styles.fieldList}>
                    {metricFields.map((field) => {
                      const enumState = enumFieldState[field.id];
                      return (
                        <li key={field.id} className={styles.fieldRow}>
                          {editingFieldId === field.id ? (
                            <div className={styles.fieldEditForm}>
                              <input
                                className={styles.input}
                                type="text"
                                placeholder="Label"
                                value={editLabel}
                                onChange={(event) => setEditLabel(event.target.value)}
                                aria-label={`Label for ${field.label}`}
                              />
                              <input
                                className={styles.input}
                                type="text"
                                placeholder="Description"
                                value={editDescription}
                                onChange={(event) => setEditDescription(event.target.value)}
                                aria-label={`Description for ${field.label}`}
                              />
                              {field.fieldType === 'numeric' && (
                                <input
                                  className={styles.input}
                                  type="text"
                                  placeholder="Unit"
                                  value={editUnit}
                                  onChange={(event) => setEditUnit(event.target.value)}
                                  aria-label={`Unit for ${field.label}`}
                                />
                              )}
                              {field.fieldType === 'score' && (
                                <>
                                  <input
                                    className={styles.input}
                                    type="number"
                                    placeholder="Min"
                                    value={editScoreMin}
                                    onChange={(event) => setEditScoreMin(event.target.value)}
                                    aria-label={`Minimum score for ${field.label}`}
                                  />
                                  <input
                                    className={styles.input}
                                    type="number"
                                    placeholder="Max"
                                    value={editScoreMax}
                                    onChange={(event) => setEditScoreMax(event.target.value)}
                                    aria-label={`Maximum score for ${field.label}`}
                                  />
                                </>
                              )}
                              <div className={styles.actions}>
                                <button
                                  type="button"
                                  className={styles.approveButton}
                                  onClick={() => saveFieldEdit(field)}
                                  disabled={savingFieldEdit || !editLabel.trim() || !editDescription.trim()}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className={styles.rejectButton}
                                  onClick={() => setEditingFieldId(null)}
                                  disabled={savingFieldEdit}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className={styles.fieldMain}>
                              <span className={styles.fieldLabel}>{field.label}</span>
                              <span className={styles.fieldMeta}>
                                {fieldTypeLabel(field.fieldType)}
                                {field.unit ? ` · ${field.unit}` : ''}
                                {field.fieldType === 'score' && field.scoreMin !== null && field.scoreMax !== null
                                  ? ` · ${field.scoreMin}–${field.scoreMax}`
                                  : ''}
                              </span>
                              <span className={styles.suggestionReason}>{field.description}</span>
                              <button type="button" className={styles.editButton} onClick={() => startFieldEdit(field)}>
                                Edit
                              </button>
                            </div>
                          )}
                          {field.fieldType === 'enum' && (
                            <div className={styles.fieldValues}>
                              {enumState && enumState.values.length > 0 ? (
                                <ul className={styles.approvedList}>
                                  {enumState.values.map((value) => (
                                    <li key={value} className={styles.pill}>
                                      {value}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className={styles.empty}>No values yet.</p>
                              )}
                              <div className={styles.requestForm}>
                                <input
                                  className={styles.input}
                                  type="text"
                                  placeholder="Add a value directly"
                                  value={newValueByField[field.id] ?? ''}
                                  onChange={(event) =>
                                    setNewValueByField((current) => ({ ...current, [field.id]: event.target.value }))
                                  }
                                  aria-label={`New value for ${field.label}`}
                                />
                                <button
                                  type="button"
                                  className={styles.addButton}
                                  onClick={() => requestValue(field.id)}
                                  disabled={addingValueForField === field.id || !(newValueByField[field.id] ?? '').trim()}
                                >
                                  Add
                                </button>
                              </div>
                              {enumState && enumState.suggestions.length > 0 && (
                                <ul className={styles.suggestionList}>
                                  {enumState.suggestions.map((suggestion) => (
                                    <li key={suggestion.id} className={styles.suggestionRow}>
                                      <div className={styles.suggestionMain}>
                                        <span className={styles.suggestionName}>{suggestion.name}</span>
                                        <span className={styles.suggestionReason}>{suggestion.reason}</span>
                                      </div>
                                      <div className={styles.actions}>
                                        <button
                                          type="button"
                                          className={styles.approveButton}
                                          onClick={() => decideValue(field.id, suggestion.id, 'approve')}
                                          disabled={decidingId === suggestion.id}
                                        >
                                          Approve
                                        </button>
                                        <button
                                          type="button"
                                          className={styles.rejectButton}
                                          onClick={() => decideValue(field.id, suggestion.id, 'reject')}
                                          disabled={decidingId === suggestion.id}
                                        >
                                          Reject
                                        </button>
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}

        <div className={styles.fieldForm}>
          <select
            className={styles.select}
            value={newFieldMetric || categories.metric[0] || ''}
            onChange={(event) => setNewFieldMetric(event.target.value)}
            aria-label="Metric"
          >
            {categories.metric.map((metric) => (
              <option key={metric} value={metric}>
                {metric}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            type="text"
            placeholder="Field key, e.g. distance_km"
            value={newFieldKey}
            onChange={(event) => setNewFieldKey(event.target.value)}
            aria-label="Field key"
          />
          <input
            className={styles.input}
            type="text"
            placeholder="Label, e.g. Distance"
            value={newFieldLabel}
            onChange={(event) => setNewFieldLabel(event.target.value)}
            aria-label="Field label"
          />
          <select
            className={styles.select}
            value={newFieldType}
            onChange={(event) => setNewFieldType(event.target.value as MetricFieldType)}
            aria-label="Field type"
          >
            {FIELD_TYPES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {newFieldType === 'numeric' && (
            <input
              className={styles.input}
              type="text"
              placeholder="Unit, e.g. km"
              value={newFieldUnit}
              onChange={(event) => setNewFieldUnit(event.target.value)}
              aria-label="Unit"
            />
          )}
          <input
            className={styles.input}
            type="text"
            placeholder="Description — what this field captures"
            value={newFieldDescription}
            onChange={(event) => setNewFieldDescription(event.target.value)}
            aria-label="Field description"
          />
          <button
            type="button"
            className={styles.addButton}
            onClick={requestField}
            disabled={
              definingField ||
              categories.metric.length === 0 ||
              !newFieldKey.trim() ||
              !newFieldLabel.trim() ||
              !newFieldDescription.trim()
            }
          >
            Add field
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Fields suggested by the AI</h2>
        {pendingFieldSuggestions.length === 0 ? (
          <p className={styles.empty}>Nothing pending.</p>
        ) : (
          <ul className={styles.suggestionList}>
            {pendingFieldSuggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionMeta}>
                    {suggestion.metric} · {fieldTypeLabel(suggestion.fieldType)}
                    {suggestion.unit ? ` · ${suggestion.unit}` : ''}
                  </span>
                  <span className={styles.suggestionName}>{suggestion.label}</span>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideField(suggestion.id, 'approve')}
                    disabled={decidingId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.parkButton}
                    onClick={() => decideField(suggestion.id, 'park')}
                    disabled={decidingId === suggestion.id}
                  >
                    Park
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideField(suggestion.id, 'reject')}
                    disabled={decidingId === suggestion.id}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {parkedFieldSuggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Parked fields</h2>
          <ul className={styles.suggestionList}>
            {parkedFieldSuggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionMeta}>
                    {suggestion.metric} · {fieldTypeLabel(suggestion.fieldType)}
                    {suggestion.unit ? ` · ${suggestion.unit}` : ''}
                  </span>
                  <span className={styles.suggestionName}>{suggestion.label}</span>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideField(suggestion.id, 'approve')}
                    disabled={decidingId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideField(suggestion.id, 'reject')}
                    disabled={decidingId === suggestion.id}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
