use praana_core::protocol::id::Sha256Digest;
use praana_core::tools::{ToolCapabilities, ToolCatalog, ToolDescriptor, ToolName};
use serde_json::json;

fn digest() -> Sha256Digest {
    Sha256Digest::digest_bytes(b"tool-schema-v1")
}

fn descriptor(name: &str, order: u16) -> ToolDescriptor {
    ToolDescriptor {
        name: ToolName::new(name).unwrap(),
        order,
        description: format!("describe {name}"),
        strict: true,
        input_schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        output_schema: json!({"type": "object"}),
        capabilities: ToolCapabilities::empty(),
        schema_sha256: digest(),
    }
}

#[test]
fn valid_catalog_orders_by_explicit_order_not_name() {
    let catalog = ToolCatalog::try_from_descriptors(vec![
        descriptor("zeta_tool", 20),
        descriptor("alpha_tool", 10),
    ])
    .unwrap();
    let names: Vec<_> = catalog
        .descriptors()
        .iter()
        .map(|row| row.name.as_str().to_owned())
        .collect();
    assert_eq!(names, vec!["alpha_tool".to_owned(), "zeta_tool".to_owned()]);
    assert_eq!(catalog.descriptors()[0].order, 10);
    assert!(catalog.descriptors()[0].strict);
}

#[test]
fn catalog_rejects_invalid_duplicate_names_and_orders() {
    assert!(ToolName::new("BadName").is_err());
    assert!(ToolName::new("1tool").is_err());
    assert!(ToolName::new("").is_err());
    assert!(ToolCatalog::try_from_descriptors(vec![
        descriptor("read_file", 1),
        descriptor("read_file", 2),
    ])
    .is_err());
    assert!(ToolCatalog::try_from_descriptors(vec![
        descriptor("read_file", 1),
        descriptor("write_file", 1),
    ])
    .is_err());
}

#[test]
fn catalog_rejects_non_strict_and_non_object_input_schema() {
    let mut loose = descriptor("read_file", 1);
    loose.strict = false;
    assert!(ToolCatalog::try_from_descriptors(vec![loose]).is_err());

    let mut array_schema = descriptor("read_file", 1);
    array_schema.input_schema = json!(["type", "object"]);
    assert!(ToolCatalog::try_from_descriptors(vec![array_schema]).is_err());

    let mut string_type = descriptor("read_file", 1);
    string_type.input_schema = json!({"type": "string"});
    assert!(ToolCatalog::try_from_descriptors(vec![string_type]).is_err());
}
