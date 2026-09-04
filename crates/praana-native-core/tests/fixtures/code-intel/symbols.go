package fixtures

import (
	"fmt"
	"strings"
)

const FixtureConst = 42

func FixtureFunction(input string) string {
	return strings.ToUpper(fmt.Sprintf("%s!", input))
}

type FixtureStruct struct {
	Name string
}

func (f FixtureStruct) Greet() string {
	return "hello " + f.Name
}
