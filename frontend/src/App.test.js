import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders the watch party lobby", () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: /youtube watch party/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /create room/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /join room/i })).toBeInTheDocument();
});
