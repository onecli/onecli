import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";

interface RoleSelectProps {
  id: string;
  value: "admin" | "member";
  onValueChange: (value: "admin" | "member") => void;
  disabled?: boolean;
}

export const RoleSelect = ({
  id,
  value,
  onValueChange,
  disabled,
}: RoleSelectProps) => (
  <div className="flex items-center gap-4">
    <Label htmlFor={id}>Role</Label>
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-[140px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Member</SelectItem>
        <SelectItem value="admin">Admin</SelectItem>
      </SelectContent>
    </Select>
  </div>
);
