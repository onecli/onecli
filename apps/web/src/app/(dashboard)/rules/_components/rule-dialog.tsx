"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
  AnimatedTabContent,
} from "@onecli/ui/components/animated-tabs";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import type { AgentOption, PolicyRuleItem, RuleActions } from "./types";
import { ApplicationRuleForm } from "./application-rule-form";
import { CustomEndpointForm } from "./custom-endpoint-form";

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  agents: AgentOption[];
  rule?: PolicyRuleItem;
  showAgentField?: boolean;
  ruleActions?: RuleActions;
  connectedProviders?: Map<string, string[]>;
  policyMode?: PolicyMode;
}

export const RuleDialog = ({
  open,
  onOpenChange,
  onSaved,
  agents,
  rule,
  showAgentField = true,
  ruleActions,
  connectedProviders,
  policyMode,
}: RuleDialogProps) => {
  const isEdit = !!rule;
  const handleClose = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_1fr] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the rule configuration."
              : "Choose an application or create a custom endpoint rule."}
          </DialogDescription>
        </DialogHeader>

        {isEdit ? (
          <div className="min-h-0 overflow-y-auto">
            <CustomEndpointForm
              onSaved={onSaved}
              onClose={handleClose}
              agents={agents}
              rule={rule}
              showAgentField={showAgentField}
              ruleActions={ruleActions}
              policyMode={policyMode}
            />
          </div>
        ) : (
          <AnimatedTabs
            defaultValue="application"
            className="min-h-0 grid grid-rows-[auto_1fr]"
          >
            <AnimatedTabList>
              <AnimatedTabTrigger value="application">
                Application
              </AnimatedTabTrigger>
              <AnimatedTabTrigger value="custom">
                Custom endpoint
              </AnimatedTabTrigger>
            </AnimatedTabList>
            <AnimatedTabContent
              value="application"
              className="min-h-0 space-y-4 overflow-y-auto pt-4"
            >
              <ApplicationRuleForm
                onSaved={onSaved}
                onClose={handleClose}
                ruleActions={ruleActions}
                connectedProviders={connectedProviders}
                policyMode={policyMode}
              />
            </AnimatedTabContent>
            <AnimatedTabContent
              value="custom"
              className="min-h-0 overflow-y-auto pt-6"
            >
              <CustomEndpointForm
                onSaved={onSaved}
                onClose={handleClose}
                agents={agents}
                showAgentField={showAgentField}
                ruleActions={ruleActions}
                policyMode={policyMode}
              />
            </AnimatedTabContent>
          </AnimatedTabs>
        )}
      </DialogContent>
    </Dialog>
  );
};
