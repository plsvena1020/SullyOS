
import React from 'react';
import { X } from '@phosphor-icons/react';
import { AnimatePresence, m, modalPanelVariants, scrimVariants } from '../../utils/motion';

interface ModalProps {
    isOpen: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ isOpen, title, onClose, children, footer }) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <m.div key="modal" className="fixed inset-0 z-[100] flex items-center justify-center p-6"
                    variants={scrimVariants()} initial="initial" animate="animate" exit="exit">
                    <div className="absolute inset-0 bg-black/40" onClick={onClose} />
                    <m.div className="relative w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl border border-white/20 overflow-hidden"
                        variants={modalPanelVariants()} initial="initial" animate="animate" exit="exit">
                {/* 物理关闭按钮：始终存在，任何情况下都可关闭弹窗 */}
                <button
                    onClick={onClose}
                    aria-label="关闭"
                    className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100/80 backdrop-blur text-slate-500 hover:bg-slate-200 hover:text-slate-700 active:scale-90 transition-all"
                >
                    <X size={16} weight="bold" />
                </button>
                <div className="px-6 pt-6 pb-2">
                    <h3 className="text-lg font-bold text-slate-800 text-center">{title}</h3>
                </div>
                <div className="px-6 py-4 max-h-[60vh] overflow-y-auto no-scrollbar">
                    {children}
                </div>
                {footer ? (
                    <div className="px-6 pb-6 flex gap-3">
                        {footer}
                    </div>
                ) : (
                    <div className="px-6 pb-6">
                        <button 
                            onClick={onClose}
                            className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            关闭
                        </button>
                    </div>
                )}
                    </m.div>
                </m.div>
            )}
        </AnimatePresence>
    );
};

export default Modal;
