use super::*;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InputMessageContract {
    text_fields: Vec<String>,
    #[serde(default)]
    client_context_field: Option<String>,
    #[serde(default)]
    attachments_field: Option<String>,
    #[serde(default)]
    identity_field: Option<String>,
    identity_required: bool,
    #[serde(default)]
    context_fields: Vec<String>,
    #[serde(default)]
    request_context_fields: BTreeMap<String, InputMessageContextKind>,
    #[serde(default)]
    disposition: InputMessageDisposition,
}

#[derive(serde::Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum InputMessageDisposition {
    #[default]
    Turn,
    Context,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum InputMessageContextKind {
    Array,
    Object,
}

pub(crate) struct DecodedInputMessage {
    pub(crate) input: Vec<UserInput>,
    pub(crate) control_id: Option<String>,
}

pub(crate) fn input_message_contracts(
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<BTreeMap<String, InputMessageContract>, InterfaceDriverError> {
    let Some(value) = config.get("input_messages") else { return Ok(BTreeMap::new()); };
    let contracts: BTreeMap<String, InputMessageContract> = serde_json::from_value(value.clone())
        .map_err(|error| InterfaceDriverError::Protocol(format!("provider input_messages is malformed: {error}")))?;
    for (label, contract) in &contracts {
        let invalid = || InterfaceDriverError::Protocol(format!("provider input_messages contract '{label}' has invalid fields"));
        if label.is_empty() || label.trim() != label || label == OPERATOR_TURN_CONTROL_LABEL
            || contract.text_fields.is_empty() && contract.request_context_fields.is_empty()
            || contract.identity_required && contract.identity_field.is_none() {
            return Err(invalid());
        }
        let mut fields = BTreeSet::new();
        for field in contract.text_fields.iter().chain(contract.client_context_field.iter())
            .chain(contract.attachments_field.iter()).chain(contract.identity_field.iter())
            .chain(contract.context_fields.iter()).chain(contract.request_context_fields.keys()) {
            if field.is_empty() || field.trim() != field || !fields.insert(field) { return Err(invalid()); }
        }
    }
    Ok(contracts)
}

fn declared_disposition(config: Option<&serde_json::Map<String, serde_json::Value>>, label: &str) -> Option<InputMessageDisposition> {
    input_message_contracts(config?).ok()?.remove(label).map(|contract| contract.disposition)
}

/// A declared input that starts a model turn.
pub(crate) fn is_declared_input_message(descriptor: &InterfaceDescriptor, label: &str) -> bool {
    let config = descriptor.interface_driver_config.as_ref().map(|config| &config.private_config);
    declared_disposition(config, label) == Some(InputMessageDisposition::Turn)
}

/// A declared input with `disposition: "context"`: it joins the conversation
/// as queued context and starts no turn.
pub(crate) fn is_declared_context_message(config: Option<&serde_json::Map<String, serde_json::Value>>, label: &str) -> bool {
    declared_disposition(config, label) == Some(InputMessageDisposition::Context)
}

pub(crate) fn decode_input_message(
    config: &serde_json::Map<String, serde_json::Value>,
    label: &str,
    bytes: &[u8],
    selected_files: Option<&SelectedFileProjection>,
) -> Result<Option<DecodedInputMessage>, InterfaceDriverError> {
    let contracts = input_message_contracts(config)?;
    let Some(contract) = contracts.get(label) else { return Ok(None); };
    let invalid = |detail: String| InterfaceDriverError::Protocol(format!("declared input message '{label}' {detail}"));
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("is not JSON: {error}")))?;
    let object = value.as_object().ok_or_else(|| invalid("must be an object".into()))?;
    let mut normalized = serde_json::Map::new();
    for field in &contract.text_fields {
        if let Some(value) = object.get(field) {
            if value.is_null() { continue; }
            let text = value.as_str().ok_or_else(|| invalid(format!("field '{field}' must be text")))?;
            if !text.trim().is_empty() {
                if normalized.get("text").is_some_and(|previous| previous != value) {
                    return Err(invalid("has conflicting text fields".into()));
                }
                normalized.insert("text".into(), value.clone());
            }
        }
    }
    let mut has_request_context = false;
    for (field, kind) in &contract.request_context_fields {
        let value = object.get(field).ok_or_else(|| invalid(format!("has no request context field '{field}'")))?;
        let nonempty = match kind {
            InputMessageContextKind::Array => value.as_array().map(|items| !items.is_empty()),
            InputMessageContextKind::Object => value.as_object().map(|items| !items.is_empty()),
        }.ok_or_else(|| invalid(format!("request context field '{field}' has the wrong JSON type")))?;
        has_request_context |= nonempty;
    }
    if let Some(field) = &contract.client_context_field
        && let Some(context) = object.get(field) {
        render_operator_client_context(context)?;
        normalized.insert("client_context".into(), context.clone());
    }
    if let Some(field) = &contract.attachments_field
        && let Some(attachments) = object.get(field) {
        if !attachments.is_array() { return Err(invalid(format!("field '{field}' must be an array"))); }
        normalized.insert("attachments".into(), attachments.clone());
    }
    let control_id = match contract.identity_field.as_ref().and_then(|field| object.get(field)) {
        Some(value) => Some(validated_control_id(value.as_str()
            .ok_or_else(|| invalid("identity must be text".into()))?.to_string())?),
        None if contract.identity_required => return Err(invalid("has no declared identity".into())),
        None => None,
    };
    for field in &contract.context_fields {
        if object.get(field).is_none_or(serde_json::Value::is_null) {
            return Err(invalid(format!("has no context field '{field}'")));
        }
    }
    let context = (!contract.context_fields.is_empty() || !contract.request_context_fields.is_empty())
        .then(|| serde_json::to_string(&serde_json::json!({"input_message_context":{"label":label,"fields":object}})))
        .transpose().map_err(|error| invalid(error.to_string()))?;
    let context_is_request = !normalized.contains_key("text") && has_request_context;
    if context_is_request {
        normalized.insert("text".into(), serde_json::Value::String(context.clone().expect("declared request context")));
    }
    let mut input = turn_input_from_operator_payload(&serde_json::Value::Object(normalized), selected_files)?;
    if let Some(context) = context.filter(|_| !context_is_request) {
        input.insert(0, UserInput::Text {
            text: context,
            text_elements: Vec::new(),
        });
    }
    Ok(Some(DecodedInputMessage { input, control_id }))
}
