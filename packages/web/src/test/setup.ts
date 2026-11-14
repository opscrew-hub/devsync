import { configure } from "@testing-library/react";

// Testing Library waits 1 s by default, too little under the full check's parallel load.
configure({ asyncUtilTimeout: 15_000 });
