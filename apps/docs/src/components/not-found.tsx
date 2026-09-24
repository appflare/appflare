import { HomeLayout } from "@fumadocs/base-ui/layouts/home";
import { DefaultNotFound } from "@fumadocs/base-ui/layouts/home/not-found";
import { baseOptions } from "../lib/layout.shared.tsx";

export function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <DefaultNotFound />
    </HomeLayout>
  );
}
