use std::collections::HashMap;

pub const FIXTURE_CONST: u32 = 42;

pub struct FixtureStruct {
    pub name: String,
}

impl FixtureStruct {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }

    pub fn map(&self) -> HashMap<String, u32> {
        HashMap::new()
    }
}

pub fn fixture_function(input: u32) -> u32 {
    input + FIXTURE_CONST
}
