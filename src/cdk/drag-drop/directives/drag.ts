/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Directionality} from '@angular/cdk/bidi';
import {DOCUMENT} from '@angular/common';
import {
  AfterViewInit,
  ContentChild,
  ContentChildren,
  Directive,
  ElementRef,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  Optional,
  Output,
  QueryList,
  SkipSelf,
  ViewContainerRef,
  OnChanges,
  SimpleChanges,
  ChangeDetectorRef,
  Self,
} from '@angular/core';
import {
  coerceBooleanProperty,
  coerceNumberProperty,
  coerceElement,
  BooleanInput,
} from '@angular/cdk/coercion';
import {Observable, Observer, Subject, merge} from 'rxjs';
import {startWith, take, map, takeUntil, switchMap, tap} from 'rxjs/operators';
import {
  CdkDragDrop,
  CdkDragEnd,
  CdkDragEnter,
  CdkDragExit,
  CdkDragMove,
  CdkDragStart,
  CdkDragRelease,
} from '../drag-events';
import {CDK_DRAG_HANDLE, CdkDragHandle} from './drag-handle';
import {CDK_DRAG_PLACEHOLDER, CdkDragPlaceholder} from './drag-placeholder';
import {CDK_DRAG_PREVIEW, CdkDragPreview} from './drag-preview';
import {CDK_DRAG_PARENT} from '../drag-parent';
import {DragRef, Point, PreviewContainer} from '../drag-ref';
import {CDK_DROP_LIST, CdkDropListInternal as CdkDropList} from './drop-list';
import {DragDrop} from '../drag-drop';
import {CDK_DRAG_CONFIG, DragDropConfig, DragStartDelay, DragAxis} from './config';
import {assertElementNode} from './assertions';

const DRAG_HOST_CLASS = 'cdk-drag';

/** Element that can be moved inside a CdkDropList container. */
@Directive({
  selector: '[cdkDrag]',
  exportAs: 'cdkDrag',
  host: {
    'class': DRAG_HOST_CLASS,
    '[class.cdk-drag-disabled]': 'disabled',
    '[class.cdk-drag-dragging]': '_dragRef.isDragging()',
  },
  providers: [{provide: CDK_DRAG_PARENT, useExisting: CdkDrag}],
})
export class CdkDrag<T = any> implements AfterViewInit, OnChanges, OnDestroy {
  private readonly _destroyed = new Subject<void>();
  private static _dragInstances: CdkDrag[] = [];

  /** Reference to the underlying drag instance. */
  // drag实例
  _dragRef: DragRef<CdkDrag<T>>;

  /** Elements that can be used to drag the draggable item. */
  // 拖动把手(图标) 只有点击图标才能拖动元素
  @ContentChildren(CDK_DRAG_HANDLE, {descendants: true}) _handles: QueryList<CdkDragHandle>;

  /** Element that will be used as a template to create the draggable item's preview. */
  // 预览图模板配置
  @ContentChild(CDK_DRAG_PREVIEW) _previewTemplate: CdkDragPreview;

  /** Template for placeholder element rendered to show where a draggable would be dropped. */
  // 自定义拖动占位符 用于显示即将落下的位置
  @ContentChild(CDK_DRAG_PLACEHOLDER) _placeholderTemplate: CdkDragPlaceholder;

  /** Arbitrary data to attach to this drag instance. */
  // 绑定数据到拖拽元素 可以在指令触发的@Output事件中通过属性获取该data 一般用于识别/操作data
  @Input('cdkDragData') data: T;

  /** Locks the position of the dragged element along the specified axis. */
  // 锁定拖拽坐标轴
  @Input('cdkDragLockAxis') lockAxis: DragAxis;

  /**
   * Selector that will be used to determine the root draggable element, starting from
   * the `cdkDrag` element and going up the DOM. Passing an alternate root element is useful
   * when trying to enable dragging on an element that you might not have access to.
   */
  // 替代拖动根元素(必须是拖拽元素的祖先) 即通过css选择器绑定一个无法直接访问的(如其他组件)祖先元素跟随当前拖拽元素移动
  // 如果拖动元素不是template 则查找与rootElementSelector匹配的最近祖先
  // 如果拖动元素是template  则查找rootElementSelector匹配的拖动元素父元素的最近祖先
  @Input('cdkDragRootElement') rootElementSelector: string;

  /**
   * Node or selector that will be used to determine the element to which the draggable's
   * position will be constrained. If a string is passed in, it'll be used as a selector that
   * will be matched starting from the element's parent and going up the DOM until a match
   * has been found.
   */
  // 限制拖拽移动边界在某个元素内 如过传入的是string 则从其祖先元素中查找
  @Input('cdkDragBoundary') boundaryElement: string | ElementRef<HTMLElement> | HTMLElement;

  /**
   * Amount of milliseconds to wait after the user has put their
   * pointer down before starting to drag the element.
   */
  // 鼠标点击到拖拽开始的延迟
  @Input('cdkDragStartDelay') dragStartDelay: DragStartDelay;

  /**
   * Sets the position of a `CdkDrag` that is outside of a drop container.
   * Can be used to restore the element's position for a returning user.
   */
  // 手动指定拖拽元素的位置
  @Input('cdkDragFreeDragPosition') freeDragPosition: Point;

  /** Whether starting to drag this element is disabled. */
  // 禁用拖拽
  @Input('cdkDragDisabled')
  get disabled(): boolean {
    return this._disabled || (this.dropContainer && this.dropContainer.disabled);
  }
  set disabled(value: BooleanInput) {
    this._disabled = coerceBooleanProperty(value);
    this._dragRef.disabled = this._disabled;
  }
  private _disabled: boolean;

  /**
   * Function that can be used to customize the logic of how the position of the drag item
   * is limited while it's being dragged. Gets called with a point containing the current position
   * of the user's pointer on the page, a reference to the item being dragged and its dimensions.
   * Should return a point describing where the item should be rendered.
   * @userPointerPosition 用户指针位置
   * @dragRef 当前拖拽元素
   * @ClientRect 包含元素大小及相对视口位置
   * 返回值为当前元素应该被渲染的位置
   */
  // 自定义拖拽位置限定逻辑的回调函数
  @Input('cdkDragConstrainPosition') constrainPosition?: (
    userPointerPosition: Point,
    dragRef: DragRef,
    dimensions: ClientRect,
    pickupPositionInElement: Point,
  ) => Point;

  /** Class to be added to the preview element. */
  // 预览元素的css类
  @Input('cdkDragPreviewClass') previewClass: string | string[];

  /**
   * Configures the place into which the preview of the item will be inserted. Can be configured
   * globally through `CDK_DROP_LIST`. Possible values:
   * - `global` - Preview will be inserted at the bottom of the `<body>`. The advantage is that
   * you don't have to worry about `overflow: hidden` or `z-index`, but the item won't retain
   * its inherited styles.
   * - `parent` - Preview will be inserted into the parent of the drag item. The advantage is that
   * inherited styles will be preserved, but it may be clipped by `overflow: hidden` or not be
   * visible due to `z-index`. Furthermore, the preview is going to have an effect over selectors
   * like `:nth-child` and some flexbox configurations.
   * - `ElementRef<HTMLElement> | HTMLElement` - Preview will be inserted into a specific element.
   * Same advantages and disadvantages as `parent`.
   */
  // 配置预览在Html的插入位置。可以通过 CDK_DROP_LIST 进行全局配置
  // global —— 预览将插入在 <body> 的底部。优点是你不必担心 overflow: hidden 或 z-index，但条目不会保留其继承的样式
  // parent —— 预览将插入到拖动条目的父级中。优点是已继承的样式将被保留，但可能会被 overflow: hidden 裁剪，由于 z-index 而变得不可见。
  // 此外，该预览将对选择器如 :nth-child 和一些 flexbox 配置产生影响。
  // ElementRef<HTMLElement> | HTMLElement 预览将插入到特定元素中。具有和 parent 一样的优点和缺点。
  @Input('cdkDragPreviewContainer') previewContainer: PreviewContainer;

  // 事件通知顺序started-> moved ->exited ->entered ->released ->ended ->dropped
  /** Emits when the user starts dragging the item. */
  // 拖拽开始事件通知
  @Output('cdkDragStarted') readonly started: EventEmitter<CdkDragStart> =
    new EventEmitter<CdkDragStart>();

  /** Emits when the user has released a drag item, before any animations have started. */
  // 释放拖拽元素通知 会在所有动画开始前执行
  @Output('cdkDragReleased') readonly released: EventEmitter<CdkDragRelease> =
    new EventEmitter<CdkDragRelease>();

  /** Emits when the user stops dragging an item in the container. */
  // 停止拖拽时发出通知
  @Output('cdkDragEnded') readonly ended: EventEmitter<CdkDragEnd> = new EventEmitter<CdkDragEnd>();

  /** Emits when the user has moved the item into a new container. */
  // 移入到新容器时通知
  @Output('cdkDragEntered') readonly entered: EventEmitter<CdkDragEnter<any>> = new EventEmitter<
    CdkDragEnter<any>
  >();

  /** Emits when the user removes the item its container by dragging it into another container. */
  // 退出所在容器时通知 先调用exited 再调用 entered
  @Output('cdkDragExited') readonly exited: EventEmitter<CdkDragExit<any>> = new EventEmitter<
    CdkDragExit<any>
  >();

  /** Emits when the user drops the item inside a container. */
  // 落入容器时通知
  @Output('cdkDragDropped') readonly dropped: EventEmitter<CdkDragDrop<any>> = new EventEmitter<
    CdkDragDrop<any>
  >();

  /**
   * Emits as the user is dragging the item. Use with caution,
   * because this event will fire for every pixel that the user has dragged.
   */
  @Output('cdkDragMoved')
  // 用户拖拽元素时通知 调用频繁 谨慎使用
  readonly moved: Observable<CdkDragMove<T>> = new Observable(
    (observer: Observer<CdkDragMove<T>>) => {
      const subscription = this._dragRef.moved
        .pipe(
          map(movedEvent => ({
            source: this,
            pointerPosition: movedEvent.pointerPosition,
            event: movedEvent.event,
            delta: movedEvent.delta,
            distance: movedEvent.distance,
          })),
        )
        .subscribe(observer);

      return () => {
        subscription.unsubscribe();
      };
    },
  );

  constructor(
    /** Element that the draggable is attached to. */
    // 指令绑定的拖拽目标元素
    public element: ElementRef<HTMLElement>,
    /** Droppable container that the draggable is a part of. */
    // 注入父元素的CdkDropList指令
    @Inject(CDK_DROP_LIST) @Optional() @SkipSelf() public dropContainer: CdkDropList,
    /**
     * @deprecated `_document` parameter no longer being used and will be removed.
     * @breaking-change 12.0.0
     */
    @Inject(DOCUMENT) _document: any,
    private _ngZone: NgZone,
    private _viewContainerRef: ViewContainerRef,
    // 注入全局配置
    @Optional() @Inject(CDK_DRAG_CONFIG) config: DragDropConfig,
    // 注入文字方向
    @Optional() private _dir: Directionality,
    // 注入DragDrop服务
    dragDrop: DragDrop,
    private _changeDetectorRef: ChangeDetectorRef,
    @Optional() @Self() @Inject(CDK_DRAG_HANDLE) private _selfHandle?: CdkDragHandle,
    @Optional() @SkipSelf() @Inject(CDK_DRAG_PARENT) private _parentDrag?: CdkDrag,
  ) {
    // 创建dragRef 绑定监听mousedown/touchstart/dragstart事件
    this._dragRef = dragDrop.createDrag(element, {
      dragStartThreshold:
        config && config.dragStartThreshold != null ? config.dragStartThreshold : 5,
      pointerDirectionChangeThreshold:
        config && config.pointerDirectionChangeThreshold != null
          ? config.pointerDirectionChangeThreshold
          : 5,
      zIndex: config?.zIndex,
    });
    // 默认设置data为当前拖拽实例
    this._dragRef.data = this;

    // We have to keep track of the drag instances in order to be able to match an element to
    // a drag instance. We can't go through the global registry of `DragRef`, because the root
    // element could be different.
    // 我们必须跟踪拖动实例，以便能够将元素与拖动实例相匹配。我们无法遍历“DragRef”的全局注册表，因为根元素可能不同。
    CdkDrag._dragInstances.push(this);

    // 全局默认设置
    if (config) {
      this._assignDefaults(config);
    }

    // Note that usually the container is assigned when the drop list is picks up the item, but in
    // some cases (mainly transplanted views with OnPush, see #18341) we may end up in a situation
    // where there are no items on the first change detection pass, but the items get picked up as
    // soon as the user triggers another pass by dragging. This is a problem, because the item would
    // have to switch from standalone mode to drag mode in the middle of the dragging sequence which
    // is too late since the two modes save different kinds of information. We work around it by
    // assigning the drop container both from here and the list.
    // 请注意，通常容器是在droplist拾取项目时分配的，
    // 但在某些情况下（主要是使用 OnPush，请参见 18341）我们可能会遇到第一次变化检测传递时没有获取到项目的情况，
    // 但是一旦用户通过拖动触发另一次传递，这些项目就会被拾取。
    // 这是一个问题，因为项目必须在拖动序列的中间从独立模式切换到拖动模式，
    // 这为时已晚，因为这两种模式保存了不同类型的信息。我们通过从此处和列表中分配放置容器来解决这个问题。
    if (dropContainer) {
      // 在拖拽元素中登记dropContainer
      this._dragRef._withDropContainer(dropContainer._dropListRef);
      // 在dropContainer添加当前拖拽元素
      dropContainer.addItem(this);
    }

    // 将 CdkDrag 的@Input输入与底层 DragRef 的属性同步
    this._syncInputs(this._dragRef);
    // 处理来自底层“DragRef”的事件 转换为组件的@Output
    this._handleEvents(this._dragRef);
  }

  /**
   * Returns the element that is being used as a placeholder
   * while the current element is being dragged.
   */
  getPlaceholderElement(): HTMLElement {
    return this._dragRef.getPlaceholderElement();
  }

  /** Returns the root draggable element. */
  getRootElement(): HTMLElement {
    return this._dragRef.getRootElement();
  }

  /** Resets a standalone drag item to its initial position. */
  reset(): void {
    this._dragRef.reset();
  }

  /**
   * Gets the pixel coordinates of the draggable outside of a drop container.
   */
  getFreeDragPosition(): Readonly<Point> {
    return this._dragRef.getFreeDragPosition();
  }

  /**
   * Sets the current position in pixels the draggable outside of a drop container.
   * @param value New position to be set.
   */
  setFreeDragPosition(value: Point): void {
    this._dragRef.setFreeDragPosition(value);
  }

  ngAfterViewInit() {
    // Normally this isn't in the zone, but it can cause major performance regressions for apps
    // using `zone-patch-rxjs` because it'll trigger a change detection when it unsubscribes.
    // 通常这不在zone中执行，但它可能会导致使用 `zone-patch-rxjs` 的应用程序出现重大性能下降，因为它会在取消订阅时触发更改检测。
    this._ngZone.runOutsideAngular(() => {
      // We need to wait for the zone to stabilize, in order for the reference
      // element to be in the proper place in the DOM. This is mostly relevant
      // for draggable elements inside portals since they get stamped out in
      // their original DOM position and then they get transferred to the portal.
      // 我们需要等待区域稳定下来，以便引用元素位于 DOM 中的正确位置。
      // 这主要与门户内的可拖动元素相关，因为它们在其原始 DOM 位置被标记出来，然后被转移到门户
      this._ngZone.onStable.pipe(take(1), takeUntil(this._destroyed)).subscribe(() => {
        // 更新rootElement
        this._updateRootElement();
        // 设置拖动图表与拖动引用同步的侦听器。
        this._setupHandlesListener();

        if (this.freeDragPosition) {
          this._dragRef.setFreeDragPosition(this.freeDragPosition);
        }
      });
    });
  }

  // 监听rootElementSelector/freeDragPosition变化
  ngOnChanges(changes: SimpleChanges) {
    const rootSelectorChange = changes['rootElementSelector'];
    const positionChange = changes['freeDragPosition'];

    // We don't have to react to the first change since it's being
    // handled in `ngAfterViewInit` where it needs to be deferred.
    // 我们不必对第一个更改做出反应，因为它在需要延迟的 ngAfterViewInit 中处理。
    if (rootSelectorChange && !rootSelectorChange.firstChange) {
      this._updateRootElement();
    }

    // Skip the first change since it's being handled in `ngAfterViewInit`.
    if (positionChange && !positionChange.firstChange && this.freeDragPosition) {
      this._dragRef.setFreeDragPosition(this.freeDragPosition);
    }
  }

  ngOnDestroy() {
    if (this.dropContainer) {
      this.dropContainer.removeItem(this);
    }

    const index = CdkDrag._dragInstances.indexOf(this);
    if (index > -1) {
      CdkDrag._dragInstances.splice(index, 1);
    }

    // Unnecessary in most cases, but used to avoid extra change detections with `zone-paths-rxjs`.
    this._ngZone.runOutsideAngular(() => {
      this._destroyed.next();
      this._destroyed.complete();
      this._dragRef.dispose();
    });
  }

  /** Syncs the root element with the `DragRef`. */
  private _updateRootElement() {
    const element = this.element.nativeElement as HTMLElement;
    let rootElement = element;
    if (this.rootElementSelector) {
      rootElement =
        element.closest !== undefined
          ? (element.closest(this.rootElementSelector) as HTMLElement)
          : // Comment tag doesn't have closest method, so use parent's one.
            // 注解元素如模板template无法使用closest 方法,所以使用父元素的
            (element.parentElement?.closest(this.rootElementSelector) as HTMLElement);
    }

    if (rootElement && (typeof ngDevMode === 'undefined' || ngDevMode)) {
      assertElementNode(rootElement, 'cdkDrag');
    }

    this._dragRef.withRootElement(rootElement || element);
  }

  /** Gets the boundary element, based on the `boundaryElement` value. */
  private _getBoundaryElement() {
    const boundary = this.boundaryElement;

    if (!boundary) {
      return null;
    }

    if (typeof boundary === 'string') {
      return this.element.nativeElement.closest<HTMLElement>(boundary);
    }

    return coerceElement(boundary);
  }

  /** Syncs the inputs of the CdkDrag with the options of the underlying DragRef. */
  // 将 CdkDrag 的输入与底层 DragRef 的选项同步
  private _syncInputs(ref: DragRef<CdkDrag<T>>) {
    ref.beforeStarted.subscribe(() => {
      if (!ref.isDragging()) {
        const dir = this._dir;
        const dragStartDelay = this.dragStartDelay;
        const placeholder = this._placeholderTemplate
          ? {
              template: this._placeholderTemplate.templateRef,
              context: this._placeholderTemplate.data,
              viewContainer: this._viewContainerRef,
            }
          : null;
        const preview = this._previewTemplate
          ? {
              template: this._previewTemplate.templateRef,
              context: this._previewTemplate.data,
              matchSize: this._previewTemplate.matchSize,
              viewContainer: this._viewContainerRef,
            }
          : null;

        ref.disabled = this.disabled;
        ref.lockAxis = this.lockAxis;
        ref.dragStartDelay =
          typeof dragStartDelay === 'object' && dragStartDelay
            ? dragStartDelay
            : coerceNumberProperty(dragStartDelay);
        ref.constrainPosition = this.constrainPosition;
        ref.previewClass = this.previewClass;
        ref
          .withBoundaryElement(this._getBoundaryElement())
          .withPlaceholderTemplate(placeholder)
          .withPreviewTemplate(preview)
          .withPreviewContainer(this.previewContainer || 'global');

        if (dir) {
          ref.withDirection(dir.value);
        }
      }
    });

    // This only needs to be resolved once.
    ref.beforeStarted.pipe(take(1)).subscribe(() => {
      // If we managed to resolve a parent through DI, use it.
      // 自动注入的parentDrag不为空 则使用
      if (this._parentDrag) {
        ref.withParent(this._parentDrag._dragRef);
        return;
      }

      // Otherwise fall back to resolving the parent by looking up the DOM. This can happen if
      // the item was projected into another item by something like `ngTemplateOutlet`.
      // 否则回退到通过查找 DOM 来解析父对象。
      // 如果该项目被诸如 `ngTemplateOutlet` 之类的东西投影到另一个项目中，就会发生这种情况
      let parent = this.element.nativeElement.parentElement;
      while (parent) {
        if (parent.classList.contains(DRAG_HOST_CLASS)) {
          ref.withParent(
            CdkDrag._dragInstances.find(drag => {
              return drag.element.nativeElement === parent;
            })?._dragRef || null,
          );
          break;
        }
        parent = parent.parentElement;
      }
    });
  }

  /** Handles the events from the underlying `DragRef`. */
  // 处理来自底层“DragRef”的事件
  private _handleEvents(ref: DragRef<CdkDrag<T>>) {
    ref.started.subscribe(startEvent => {
      this.started.emit({source: this, event: startEvent.event});

      // Since all of these events run outside of change detection,
      // we need to ensure that everything is marked correctly.
      this._changeDetectorRef.markForCheck();
    });

    ref.released.subscribe(releaseEvent => {
      this.released.emit({source: this, event: releaseEvent.event});
    });

    ref.ended.subscribe(endEvent => {
      this.ended.emit({
        source: this,
        distance: endEvent.distance,
        dropPoint: endEvent.dropPoint,
        event: endEvent.event,
      });

      // Since all of these events run outside of change detection,
      // we need to ensure that everything is marked correctly.
      this._changeDetectorRef.markForCheck();
    });

    ref.entered.subscribe(enterEvent => {
      this.entered.emit({
        container: enterEvent.container.data,
        item: this,
        currentIndex: enterEvent.currentIndex,
      });
    });

    ref.exited.subscribe(exitEvent => {
      this.exited.emit({
        container: exitEvent.container.data,
        item: this,
      });
    });

    ref.dropped.subscribe(dropEvent => {
      this.dropped.emit({
        previousIndex: dropEvent.previousIndex,
        currentIndex: dropEvent.currentIndex,
        previousContainer: dropEvent.previousContainer.data,
        container: dropEvent.container.data,
        isPointerOverContainer: dropEvent.isPointerOverContainer,
        item: this,
        distance: dropEvent.distance,
        dropPoint: dropEvent.dropPoint,
        event: dropEvent.event,
      });
    });
  }

  /** Assigns the default input values based on a provided config object. */
  private _assignDefaults(config: DragDropConfig) {
    const {
      lockAxis,
      dragStartDelay,
      constrainPosition,
      previewClass,
      boundaryElement,
      draggingDisabled,
      rootElementSelector,
      previewContainer,
    } = config;

    this.disabled = draggingDisabled == null ? false : draggingDisabled;
    this.dragStartDelay = dragStartDelay || 0;

    if (lockAxis) {
      this.lockAxis = lockAxis;
    }

    if (constrainPosition) {
      this.constrainPosition = constrainPosition;
    }

    if (previewClass) {
      this.previewClass = previewClass;
    }

    if (boundaryElement) {
      this.boundaryElement = boundaryElement;
    }

    if (rootElementSelector) {
      this.rootElementSelector = rootElementSelector;
    }

    if (previewContainer) {
      this.previewContainer = previewContainer;
    }
  }

  /** Sets up the listener that syncs the handles with the drag ref. */
  // 设置拖动图标与拖动引用同步的侦听器。
  private _setupHandlesListener() {
    // Listen for any newly-added handles.
    this._handles.changes
      .pipe(
        // 发出的初始值
        startWith(this._handles),
        // Sync the new handles with the DragRef.
        // 同步新的拖动把手与DragRef
        tap((handles: QueryList<CdkDragHandle>) => {
          const childHandleElements = handles
            // _parentDrag在handle指令创建时就已注入
            .filter(handle => handle._parentDrag === this)
            .map(handle => handle.element);

          // Usually handles are only allowed to be a descendant of the drag element, but if
          // the consumer defined a different drag root, we should allow the drag element
          // itself to be a handle too.
          // 通常拖动把手只允许作为拖动元素的后代，但如果用户定义了不同的拖动rootElement，我们也应该允许拖动元素本身作为句柄。
          if (this._selfHandle && this.rootElementSelector) {
            childHandleElements.push(this.element);
          }

          // 注册handles 更新handles是否可交互/及禁用的handles集合
          this._dragRef.withHandles(childHandleElements);
        }),
        // Listen if the state of any of the handles changes.
        switchMap((handles: QueryList<CdkDragHandle>) => {
          return merge(
            ...handles.map(item => {
              return item._stateChanges.pipe(startWith(item));
            }),
          ) as Observable<CdkDragHandle>;
        }),
        takeUntil(this._destroyed),
      )
      .subscribe(handleInstance => {
        // Enabled/disable the handle that changed in the DragRef.
        const dragRef = this._dragRef;
        const handle = handleInstance.element.nativeElement;
        handleInstance.disabled ? dragRef.disableHandle(handle) : dragRef.enableHandle(handle);
      });
  }
}
