export type Message = NavigationMessage | ContentMessage;

export interface NavigationMessage {
    Navigation: RootNavigationItem;
}

export interface RootNavigationItem extends NavigationItem {
    name: never;
    item: NavigationItem[];
}

export interface ItemBase {
    $: { id: string };
    name: string[];
}

export interface NavigationItem extends ItemBase {
    readOnly?: ['true' | 'false'];
    item?: NavigationItem[];
}

export interface ContentMessage {
    Content: { item: ContentSection[] };
}

export interface ContentSection extends ItemBase {
    item: ContentItem[];
}

export type ContentItem = ReadOnlyContentItem | SelectContentItem | NumberContentItem;

export interface ReadOnlyContentItem extends ItemBase {
    value: [string];
    raw?: [string];
}

export interface SelectContentItem extends ItemBase {
    option: SelectOption[];
    raw: [string];
    value: [string];
}

export interface SelectOption {
    _: string;
    $: { value: string };
}

export interface NumberContentItem extends ItemBase {
    min: [string];
    max: [string];
    step: [string];
    unit: [string];
    div: [string];
    raw: [string];
    value: [string];
}
