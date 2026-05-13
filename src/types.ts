export type Priority = "none" | "high" | "medium" | "low";

export interface Section {
  id: string;
  name: string;
  ordering: number;
}

export interface List {
  id: string;
  name: string;
  color: string | null;
  source: string;
  allows_modifications: boolean;
  sections: Section[];
}

export interface Reminder {
  id: string;
  list_id: string;
  list_name: string;
  section_id: string | null;
  title: string;
  notes: string | null;
  priority: Priority;
  due: string | null;
  due_all_day: boolean;
  completed: boolean;
  completion_date: string | null;
  creation_date: string | null;
  modification_date: string | null;
  flagged: boolean;
  url: string | null;
  parent_id: string | null;
  subtask_ids: string[];
  tags: string[];
}

export interface ReminderWithSubtasks extends Omit<Reminder, "subtask_ids"> {
  subtasks: ReminderWithSubtasks[];
}

// Shape produced by remindersd before tag/section merge.
export interface RawReminder extends Omit<Reminder, "tags" | "section_id"> {}

export interface RawList extends Omit<List, "sections"> {}
